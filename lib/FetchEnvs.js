/*
 * Copyright 2020, 2022 IBM Corp. All Rights Reserved.
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
    return 'FetchEnvs';
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
        kubeError = error;
      }
    }

    const data = resource?.data;

    if (!data) {
      console.log(kubeError);
      const msg = `failed to get envFrom: ${JSON.stringify(conf)}. ${kubeError.message || kubeError}`;
      const err = new Error(msg);
      err.code = kubeError.statusCode;
      if (!optional || (err.code != 404 && kubeError != ERR_NODATA)) throw err;
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

    const matchLabelsQS = labelSelectors(matchLabels);

    if (krm) {
      try {
        response = await this.api({
          uri: krm.uri({ namespace, name }),
          json: true,
          qs: matchLabelsQS
        });
      } catch (error) {
        kubeError = error;
      }
    }

    let value = response?.data?.[key];

    if (typeof matchLabelsQS === OBJECT) {
      const output = response?.items.reduce(
        reduceItemList(ref, strategy, decode),
        Object.create(null)
      );

      value = output?.[key];
      decode = false;
    }

    if (value === undefined) {
      if (defaultValue === undefined || (kubeError.statusCode != 404 && kubeError != ERR_NODATA)) {
        const msg = `failed to get env: ${JSON.stringify(conf)}. ${kubeError.message || kubeError}`;
        const err = new Error(msg);
        err.code = kubeError.statusCode;
        if (!optional || (err.code != 404 && kubeError != ERR_NODATA)) throw err;
        log.warn(msg);
        this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
      } else {
        value = defaultValue;
        decode = false;
        const msg = `failed to get env: ${JSON.stringify(conf)}. Using default value: ${defaultValue}`;

        log.warn(msg);
        this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
      }
    }

    value = (decode && typeof value == STRING)
      ? Buffer.from(value, 'base64').toString()
      : value;

    return typeCast(name, value, type);
  }


  processEnvFrom(envFrom) {
    return Promise.all(envFrom.map((element) => {
      const { configMapRef, secretMapRef, genericMapRef } = element;

      if (!configMapRef && !secretMapRef && !genericMapRef) {
        throw new Error(`oneOf configMapRef, secretMapRef, genericMapRef must be defined. Got: ${JSON.stringify(element)}`);
      }

      if (configMapRef) return this.#configMapRef(element);
      if (secretMapRef) return this.#secretMapRef(element);
      return this.#genericMapRef(element);
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

  #processEnvSourceSimpleLinks(envs) {
    return Promise.all(envs.map(async (env) => {
      if (env.value) return env;
      const parentNamespace = this.namespace;
      if (env.valueFrom) return { ...env, parentNamespace };
      return { valueFrom: env, parentNamespace };
    }));
  }

  async get(path = 'spec') {
    let result = {};
    // removes any number of '.' at the start and end of the path, and
    // removes the '.env' or '.envFrom' if the paths ends in either
    path = path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '');

    let envFrom = objectPath.get(this.data, `object.${path}.envFrom`, []);
    envFrom = await this.processEnvFrom(envFrom);
    for (const env of envFrom) {
      const data = env?.data ?? {};
      result = { ...result, ...data };
    }

    const env = objectPath.get(this.data, `object.${path}.env`, []);
    return (await this.#processEnv(env)).reduce(reduceEnv, result);
  }

  async getSourceSimpleLinks(path = 'spec') {
    let result = {};
    // removes any number of '.' at the start and end of the path, and
    // removes the '.env' or '.envFrom' if the paths ends in either
    path = path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '');

    const envFrom = objectPath.get(this.data, `object.${path}.envFrom`, []);
    result = (await this.#processEnvSourceSimpleLinks(envFrom)).reduce(reduceEnvSourceSimpleLinks, result);

    const env = objectPath.get(this.data, `object.${path}.env`, []);
    return (await this.#processEnvSourceSimpleLinks(env)).reduce(reduceEnvSourceSimpleLinks, result);
  }
};

function reduceItemList(ref, strategy, decode) {
  const { key, name, type } = ref;
  return (output, item) => {
    const tmp = item?.data?.[key];
    const value = (decode && typeof tmp === STRING)
      ? typeCast(name, Buffer.from(tmp, 'base64').toString(), type)
      : typeCast(name, tmp, type);

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

function reduceEnvSourceSimpleLinks(output, conf) {
  const { valueFrom, parentNamespace  } = conf;
  if (valueFrom !== undefined) {
    const sourceRefType = Object.keys(valueFrom)[0];
    const sourceValueFromInfo = valueFrom[sourceRefType];
    //if sourceValueFromInfo has a kind property, source is genericMapRef.
    //if it doesn't have kind property, source is configMapRef or secretMapRef, use KIND_MAP to find which
    const sourceKind = objectPath.get( sourceValueFromInfo, 'kind', KIND_MAP.get(sourceRefType));;
    const sourceNamespace = sourceValueFromInfo.namespace || parentNamespace;
    const sourceApiVersion = sourceValueFromInfo.apiVersion || 'v1';
    const sourceSimpleLink = `${sourceApiVersion}:${sourceKind}/${sourceNamespace}/${sourceValueFromInfo.name}`;
    const sourceData = {[sourceKind]: [sourceSimpleLink]};
    output = merge(output, sourceData);
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

function typeCast(name, value, type) {
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
      if (value) {
        try {
          return JSON.parse(value);
        } catch (error) {
          throw new Error(`JSON invalid in ref ${name}: ${value}. Parse error: (${error})`);
        }
      }
      return {};
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

const objectPath = {
  get: function (obj, path, def) {
    if (typeof path === 'string') {
      const output = [];
      path.split('.').forEach(function (item) {
        // Split to an array with bracket notation
        item.split(/\[([^}]+)\]/g).forEach(function (key) {
          // Push to the new array
          if (key.length > 0) {
            output.push(key);
          }
        });
      });
      path = output;
    }

    // Cache the current object
    var current = obj;
    // For each item in the path, dig into the object
    for (var i = 0; i < path.length; i++) {
      // If the item isn't found, return the default (or null)
      if (!current[path[i]]) return def;
      // Otherwise, update the current  value
      current = current[path[i]];
    }

    return current;
  }
};
