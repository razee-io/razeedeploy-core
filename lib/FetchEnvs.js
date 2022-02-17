/*
 * Copyright 2020 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const merge = require('deepmerge');
const log = require('./bunyan-api').createLogger('fetchEnvs');

const STRING = 'string';
const OBJECT = 'object';
const ERR_NODATA = 'make sure your data exists in the correct location and is in the expected format.';
const KIND_MAP = new Map([
  ['secretKeyRef', 'Secret'],
  ['secretMapRef', 'Secret'],
  ['configMapRef', 'ConfigMap'],
  ['configMapKeyRef', 'ConfigMap']
]);

module.exports = class FetchEnvs {

  get [Symbol.toStringTag]() {
    return 'FetchEnv';
  }

  constructor(controllerObject) {
    if (!controllerObject) {
      throw Error('FetchEnvs must have: controller object instance');
    }
    this.data = controllerObject.data;
    this.namespace = this.data?.object?.metadata?.namespace;
    this.kubeResourceMeta = controllerObject.kubeResourceMeta;
    this.kubeClass = controllerObject.kubeClass;
    this.api = this.kubeResourceMeta.request.bind(this.kubeResourceMeta);
    this.updateRazeeLogs = controllerObject.updateRazeeLogs ?
      ((logLevel, log) => { controllerObject.updateRazeeLogs(logLevel, log); }) :
      (() => { log.debug('\'updateRazeeLogs()\' not passed to fetchEnvs. will not update razeeLogs on failure to fetch envs'); });
  }

  #secretMapRef(conf) {
    return this.#genericMapRef(conf, 'secretMapRef', true);
  }

  #secretKeyRef(conf) {
    return this.#genericKeyRef(conf, 'secretKeyRef', true);
  }

  #configMapRef(conf) {
    return this.#genericMapRef(conf, 'configMapRef');
  }

  #configMapKeyRef(conf) {
    return this.#genericKeyRef(conf, 'configMapKeyRef');
  }

  async #genericMapRef(conf, valueFrom = 'genericMapRef', decode = false) {
    let resource;
    let kubeError = ERR_NODATA;
    const ref = conf[valueFrom];
    const optional = !!conf.optional;

    const {
      apiVersion = 'v1',
      kind = KIND_MAP.get(valueFrom),
      namespace = this.namespace,
      name
    } = ref;

    const krm = await this.kubeClass.getKubeResourceMeta(apiVersion, kind, 'update');

    if (krm) {
      try {
        resource = await krm.get(name, namespace);
      } catch (error) {
        log.warn(error);
        kubeError = error.message;
      }
    }

    const data = resource?.data;

    if (!data) {
      const msg = `envFrom.${valueFrom}.${apiVersion}.${kind}.${name}.data not found: ${kubeError}`;
      if (!optional) throw new Error(msg);
      log.warn(msg);
      this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
      return { ...conf, data };
    }

    if (decode) {
      for (const [key, value] of Object.entries(data)) {
        data[key] = Buffer.from(value, 'base64').toString();
      }
    }

    return { ...conf, data };
  }

  async #genericKeyRef(conf, valueFrom = 'genericKeyRef', decode = false) {
    let response;
    let kubeError = ERR_NODATA;
    const optional = !!conf.optional;
    const defaultValue = conf.default;
    const ref = conf.valueFrom[valueFrom];
    const strategy = conf.overrideStrategy;
    const {
      name,
      key,
      matchLabels,
      type,
      namespace = this.namespace,
      kind = KIND_MAP.get(valueFrom),
      apiVersion = 'v1'
    } = ref;

    const krm = await this.kubeClass.getKubeResourceMeta(
      apiVersion,
      kind,
      'update'
    );

    if (krm) {
      try {
        response = await this.api({
          uri: krm.uri({ namespace, kind, name }),
          json: true,
          qs: labelSelectors(matchLabels)
        });
      } catch (error) {
        kubeError = error.message;
      }
    }

    let value = response?.data?.[key];

    if (matchLabels) {
      const output = response?.items.reduce(
        reduceItemList(ref, strategy, decode),
        Object.create(null)
      );

      value = output?.[key];
    } else {
      value = (decode && typeof value == STRING)
        ? Buffer.from(value, 'base64').toString()
        : value;

      typeCast(value, type);
    }

    if (value === undefined) {
      if (defaultValue === undefined) {
        const msg = `failed to get env ${JSON.stringify(ref)}, optional=${optional}: ${kubeError}`;
        log.warn(msg);

        if (!optional) {
          throw new Error(msg);
        }

        this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
      } else {
        value = defaultValue;
        const msg = `failed to get env '${JSON.stringify(ref)}', Using default value: ${defaultValue}`;
        log.warn(msg);
        this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
      }
    }

    value = (decode && typeof value == STRING)
      ? Buffer.from(value, 'base64').toString()
      : value;

    return typeCast(value, type);
  }


  #processEnvFrom(envFrom) {
    return Promise.all(envFrom.map((element) => {
      const { configMapRef, secretMapRef, genericMapRef } = element;
      if (configMapRef) return this.#configMapRef(element);
      if (secretMapRef) return this.#secretMapRef(element);
      if (genericMapRef) return this.#genericMapRef(element);
      return element;
    }));
  }

  #processEnv(envs) {
    return Promise.all(envs.map(async (env) => {
      if (env.value) return env;
      const valueFrom = env.valueFrom || {};
      const { genericKeyRef, configMapKeyRef, secretKeyRef } = valueFrom;

      if (!genericKeyRef && !configMapKeyRef && !secretKeyRef) {
        throw new Error(`oneOf genericKeyRef, configMapKeyRef, secretKeyRef must be defined. Got: ${JSON.stringify(env)}`);
      }

      let value;
      if (secretKeyRef) value = await this.#secretKeyRef(env);
      if (configMapKeyRef) value = await this.#configMapKeyRef(env);
      if (genericKeyRef) value = await this.#genericKeyRef(env);

      return { ...env, value };
    }));
  }

  async get(path = 'spec') {
    let result = {};
    // removes any number of '.' at the start and end of the path, and
    // removes the '.env' or '.envFrom' if the paths ends in either
    path = path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '');

    let envFrom = this.data?.object?.[path]?.envFrom ?? [];
    envFrom = await this.#processEnvFrom(envFrom);
    for (const env of envFrom) {
      const data = env?.data ?? {};
      result = { ...result, ...data };
    }

    const env = this.data?.object?.[path]?.env ?? [];
    return (await this.#processEnv(env)).reduce(reduceEnv, result);
  }
};

function reduceItemList(ref, strategy, decode) {
  const { key, type } = ref;
  return (output, item) => {
    const tmp = item?.data?.[key];
    const value = (decode && typeof tmp === STRING)
      ? typeCast(Buffer.from(tmp, 'base64').toString(), type)
      : typeCast(tmp, type);

    if (value !== undefined) {
      if (strategy === 'merge' && typeof output[key] === OBJECT && typeof value === OBJECT) {
        output[key] = merge(output[key], value);
      } else {
        output[key] = value;
      }
    }
    return output;
  };
}

function reduceEnv(output, conf) {
  const { value, overrideStrategy, name } = conf;

  if (value !== undefined) {
    if (overrideStrategy === 'merge' && typeof output[name] === OBJECT && typeof value === OBJECT) {
      output[name] = merge(output[name], value);
    } else {
      output[name] = value;
    }
  }

  return output;
}

function labelSelectors(query) {
  if (!query) return;

  const keys = Object.keys(query);
  if (!keys.length) return;

  return {
    labelSelector: keys.map((key) => {
      return `${key}=${query[key]}`;
    }).join(',')
  };
}

function typeCast(value, type) {
  if (!type) return value;
  if (value == null) return;
  if (typeof value !== STRING) return value;

  switch (type) {
    case 'number': {
      return Number(value);
    }
    case 'boolean': {
      return (value.toLowerCase() === 'true');
    }
    case 'json': {
      return JSON.parse(value);
    }
    case 'jsonString': {
      // Stringify the jsonstring. This has the effect of double escaping the json, so that
      // when we go to parse the final template to apply it to kube, it doesnt mistakenly
      // turn our jsonString into actual json.
      const result = JSON.stringify(value);
      // JSON.stringify adds quotes around the newly created json string. Kube forces us
      // to wrap out curly braces in quotes so that it wont error on our templates. In order
      // to avoid having 2 double quotes around the result, we need to remove the stringify
      // quotes. slice(start of slice, end of slice)
      return result.slice(1, result.length - 1);
    }
    case 'base64': {
      return Buffer.from(value).toString('base64');
    }
  }
}
