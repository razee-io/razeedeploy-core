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

const clone = require('clone');
const log = require('./bunyan-api').createLogger('reqOpts');

const ERR_NODATA = 'make sure your data exists in the correct location and is in the expected format.';
const KIND_MAP = new Map([
  ['secretKeyRef', 'Secret'],
  ['secretMapRef', 'Secret'],
  ['configMapRef', 'ConfigMap'],
  ['configMapKeyRef', 'ConfigMap']
]);

module.exports = class ReqOpts {

  get [Symbol.toStringTag]() {
    return 'ReqOpts';
  }

  constructor(controllerObject) {
    if (!controllerObject) {
      throw Error('ReqOpts must have: controller object instance');
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

  #configMapRef(conf) {
    return this.#genericMapRef(conf, 'configMapRef');
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
        kubeError = error.message;
      }
    }

    const data = resource?.data;
    
    if (!data) {
      const msg = `failed to get envFrom: ${JSON.stringify(conf)}. ${kubeError}`;
      if (!optional) throw new Error(msg);
      log.warn(msg);
      this.updateRazeeLogs('warn', { controller: 'ReqOpts', message: msg });
      return { ...conf, data };
    }

    if (decode) {
      for (const [key, value] of Object.entries(data)) {
        data[key] = Buffer.from(value, 'base64').toString();
      }
    }
    let ret = { ...conf, data };

    return ret;
  }

  #processEnvFrom(envFrom) {
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

  async get(requestOptions) {

    requestOptions = clone(requestOptions);

    let envFrom = objectPath.get(requestOptions, 'envFrom');

    if (envFrom) {
      let envFromTemp = await this.#processEnvFrom(envFrom);
      let headers = objectPath.get(requestOptions, 'headers');

      for (const env of envFromTemp) {
        const envdata = env?.data;
        headers = { ...headers, ...envdata };
      }

      requestOptions = { ...requestOptions, headers };
    }
    

    return requestOptions;

  }
};

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
