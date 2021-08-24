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

const objectPath = require('object-path');
const clone = require('clone');
const log = require('./bunyan-api').createLogger('fetchEnvs');

module.exports = class FetchEnvs {
  constructor(controllerObject) {
    if (!controllerObject) {
      throw Error('FetchEnvs must have: controller object instance');
    }
    this.data = controllerObject.data;
    this.namespace = objectPath.get(this.data, 'object.metadata.namespace');
    this.kubeResourceMeta = controllerObject.kubeResourceMeta;
    this.kubeClass = controllerObject.kubeClass;

    this.updateRazeeLogs = controllerObject.updateRazeeLogs ?
      ((logLevel, log) => { controllerObject.updateRazeeLogs(logLevel, log); }) :
      (() => { log.debug('\'updateRazeeLogs()\' not passed to fetchEnvs. will not update razeeLogs on failure to fetch envs'); });
  }

  async _lookupDataReference(valueFrom) {
    let result;
    let type;
    let uri = '';
    let key = '';
    let kubeError;
    if (valueFrom['secretKeyRef']) {
      let secretName = objectPath.get(valueFrom, 'secretKeyRef.name');
      let namespace = objectPath.get(valueFrom, 'secretKeyRef.namespace', this.namespace);
      key = objectPath.get(valueFrom, 'secretKeyRef.key');
      uri = `/api/v1/namespaces/${namespace}/secrets/${secretName}`;
      let res;
      try {
        res = await this.kubeResourceMeta.request({ uri: uri, json: true });
      } catch (e) {
        log.warn(e);
        kubeError = e.message;
      }
      if (res && objectPath.has(res, ['data', key])) {
        result = Buffer.from(objectPath.get(res, ['data', key]), 'base64').toString();
      }
      type = objectPath.get(valueFrom, 'secretKeyRef.type');
    } else if (valueFrom['configMapKeyRef']) {
      let name = objectPath.get(valueFrom, 'configMapKeyRef.name');
      let namespace = objectPath.get(valueFrom, 'configMapKeyRef.namespace', this.namespace);
      key = objectPath.get(valueFrom, 'configMapKeyRef.key');
      uri = `/api/v1/namespaces/${namespace}/configmaps/${name}`;
      let res;
      try {
        res = await this.kubeResourceMeta.request({ uri: uri, json: true });
      } catch (e) {
        log.warn(e);
        kubeError = e.message;
      }
      result = objectPath.get(res, ['data', key]);
      type = objectPath.get(valueFrom, 'configMapKeyRef.type');
    } else if (valueFrom['genericKeyRef']) {
      let apiVersion = objectPath.get(valueFrom, 'genericKeyRef.apiVersion');
      let kind = objectPath.get(valueFrom, 'genericKeyRef.kind');
      let krm = await this.kubeClass.getKubeResourceMeta(apiVersion, kind, 'update');
      let name = objectPath.get(valueFrom, 'genericKeyRef.name');
      let namespace = objectPath.get(valueFrom, 'genericKeyRef.namespace', this.namespace);
      let resource = {};
      if (krm) {
        try {
          resource = await krm.get(name, namespace);
        } catch (e) {
          log.warn(e);
          kubeError = e.message;
        }
      }
      key = objectPath.get(valueFrom, 'genericKeyRef.key');
      result = objectPath.get(resource, ['data', key]);
      type = objectPath.get(valueFrom, 'genericKeyRef.type');
    }
    if (type && result) {
      switch (type) {
        case 'number':
          result = Number(result);
          break;
        case 'boolean':
          result = (result.toLowerCase() === 'true');
          break;
        case 'json':
          result = JSON.parse(result);
          break;
        case 'jsonString':
          // Stringify the jsonstring. This has the effect of double escaping the json, so that
          // when we go to parse the final template to apply it to kube, it doesnt mistakenly
          // turn our jsonString into actual json.
          result = JSON.stringify(result);
          // JSON.stringify adds quotes around the newly created json string. Kube forces us
          // to wrap out curly braces in quotes so that it wont error on our templates. In order
          // to avoid having 2 double quotes around the result, we need to remove the stringify
          // quotes. slice(start of slice, end of slice)
          result = result.slice(1, result.length - 1);
          break;
        case 'base64':
          result = new Buffer(result).toString('base64');
          break;
      }
    }
    return kubeError === undefined ? (result) : { error: kubeError };
  }

  async _processEnvFrom(envFrom) {
    return await Promise.all(envFrom.map(async (element) => {
      const mapData = clone(element);
      let optional = objectPath.get(element, 'optional', false);
      let kubeError;
      if (objectPath.has(element, 'configMapRef')) {
        let name = objectPath.get(element, 'configMapRef.name');
        let namespace = objectPath.get(element, 'configMapRef.namespace', this.namespace);
        let res;
        try {
          res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${namespace}/configmaps/${name}`, json: true });
        } catch (e) {
          log.warn(e);
          kubeError = e.message;
        }

        let data = objectPath.get(res, 'data');
        if (kubeError === undefined) kubeError = 'no data returned from processEnvFrom. make sure your data exists in the correct location and is in the expected format.';

        if (data) {
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.configMapRef.${name}.data not found: ${kubeError}`);
        } else {
          let msg = `envFrom.configMapRef.${name}.data not found: ${kubeError}`;
          log.warn(msg);
          this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
        }
      } else if (objectPath.has(element, 'secretMapRef')) {
        let name = objectPath.get(element, 'secretMapRef.name');
        let namespace = objectPath.get(element, 'secretMapRef.namespace', this.namespace);
        let res;
        try {
          res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${namespace}/secrets/${name}`, json: true });
        } catch (e) {
          log.warn(e);
          kubeError = e.message;
        }

        let data = objectPath.get(res, 'data');
        if (kubeError === undefined) kubeError = 'no data returned from processEnvFrom. make sure your data exists in the correct location and is in the expected format.';

        if (data) {
          for (const [key, value] of Object.entries(data)) {
            data[key] = Buffer.from(value, 'base64').toString();
          }
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.secretMapRef.${name}.data not found: ${kubeError}`);
        } else {
          let msg = `envFrom.secretMapRef.${name}.data not found: ${kubeError}`;
          log.warn(msg);
          this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
        }
      } else if (objectPath.has(element, 'genericMapRef')) {
        let apiVersion = objectPath.get(element, 'genericMapRef.apiVersion');
        let kind = objectPath.get(element, 'genericMapRef.kind');
        let krm = await this.kubeClass.getKubeResourceMeta(apiVersion, kind, 'update');
        let name = objectPath.get(element, 'genericMapRef.name');
        let namespace = objectPath.get(element, 'genericMapRef.namespace', this.namespace);
        let resource = {};
        if (krm) {
          try {
            resource = await krm.get(name, namespace);
          } catch (e) {
            log.warn(e);
            kubeError = e.message;
          }
        }

        let data = objectPath.get(resource, 'data');
        if (kubeError === undefined) kubeError = 'no data returned from processEnvFrom. make sure your data exists in the correct location and is in the expected format.';

        if (data) {
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.genericMapRef.${apiVersion}.${kind}.${name}.data not found: ${kubeError}`);
        } else {
          let msg = `envFrom.genericMapRef.${apiVersion}.${kind}.${name}.data not found: ${kubeError}`;
          log.warn(msg);
          this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
        }
      }
      return mapData;
    }));
  }

  async _processEnv(env) {
    return await Promise.all(env.map(async (e) => {
      let optional = objectPath.get(e, 'optional', false);
      let defaultValue = objectPath.get(e, 'default');
      if (e.value) {
        return e;
      } else if (e.valueFrom) {
        let value;
        let kubeError;
        try {
          value = await this._lookupDataReference(e.valueFrom);
          kubeError = objectPath.get(value, 'error');
        } catch (err) {
          kubeError = err;
        }
        if (value === undefined || kubeError !== undefined) {
          if (kubeError === undefined) kubeError = 'no value returned from lookupDataReference. make sure your data exists in the correct location and is in the expected format.';
          if (defaultValue === undefined) {
            let msg = `failed to get env ${JSON.stringify(e.valueFrom)}, optional=${optional}: ${kubeError}`;
            if (!optional) {
              throw new Error(msg);
            } else {
              log.warn(msg);
              this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
            }
          } else {
            e.value = defaultValue;

            let msg = `failed to get env '${JSON.stringify(e.valueFrom)}', Using default value: ${defaultValue}`;
            log.warn(msg);
            this.updateRazeeLogs('warn', { controller: 'FetchEnvs', message: msg });
          }
        } else {
          e.value = value;
        }
        return e;
      }
    }));
  }

  async get(path = 'spec') {
    let result = {};
    // removes any number of '.' at the start and end of the path, and
    // removes the '.env' or '.envFrom' if the paths ends in either
    path = path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '');
    let envFrom = objectPath.get(this.data, `object.${path}.envFrom`, []);
    envFrom = await this._processEnvFrom(envFrom);
    envFrom.forEach((e) => {
      let data = objectPath.get(e, 'data', {});
      Object.assign(result, data);
    });

    let env = objectPath.get(this.data, `object.${path}.env`, []);
    env = await this._processEnv(env);
    env.forEach((e) => {
      if (e.value !== undefined) {
        result[e.name] = e.value;
      }
    });
    return result;
  }
};
