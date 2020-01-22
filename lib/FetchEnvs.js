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
  constructor(data, krm, kc) {
    if (!(data && krm && kc)) {
      throw Error('FetchEnvs must have: data, kubeResourceMeta, and kubeClass');
    }
    this.data = data;
    this.namespace = objectPath.get(data, 'object.metadata.namespace');
    this.kubeResourceMeta = krm;
    this.kubeClass = kc;
  }

  async _lookupDataReference(valueFrom) {
    let result;
    let type;
    let uri = '';
    let key = '';
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
          result = Boolean(result);
          break;
        case 'json':
          result = JSON.parse(result);
      }
    }
    return (result);
  }


  async _getMaps(envFrom) {
    const result = [];
    await Promise.all(envFrom.map(async (element) => {
      const mapData = clone(element);
      let optional = objectPath.get(element, 'optional', false);
      if (objectPath.has(element, 'configMapRef')) {
        let name = objectPath.get(element, 'configMapRef.name');
        let namespace = objectPath.get(element, 'configMapRef.namespace', this.namespace);
        let res;
        try {
          res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${namespace}/configmaps/${name}`, json: true });
        } catch (e) {
          log.warn(e);
        }
        let data = objectPath.get(res, 'data');
        if (data) {
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.configMapRef.${name}.data not found.`);
        } else {
          let msg = `envFrom.configMapRef.${name}.data not found.`;
          log.warn(msg);
        }
      } else if (objectPath.has(element, 'secretMapRef')) {
        let name = objectPath.get(element, 'secretMapRef.name');
        let namespace = objectPath.get(element, 'secretMapRef.namespace', this.namespace);
        let res;
        try {
          res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${namespace}/secrets/${name}`, json: true });
        } catch (e) {
          log.warn(e);
        }
        if (res && res.data) {
          let data = res.data || {};
          for (const [key, value] of Object.entries(data)) {
            data[key] = Buffer.from(value, 'base64').toString();
          }
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.secretMapRef.${name}.data not found.`);
        } else {
          let msg = `envFrom.secretMapRef.${name}.data not found.`;
          log.warn(msg);
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
          }
        }
        let data = objectPath.get(resource, 'data');
        if (data) {
          mapData.data = data;
        } else if (!optional) {
          throw new Error(`envFrom.genericMapRef.${apiVersion}.${kind}.${name}.data not found.`);
        } else {
          let msg = `envFrom.genericMapRef.${apiVersion}.${kind}.${name}.data not found.`;
          log.warn(msg);
        }
      }
      result.push(mapData);
    }));
    return result;
  }

  async get(path = 'spec') {
    let result = {};
    let envFrom = objectPath.get(this.data, `object.${path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '')}.envFrom`, []);
    envFrom = await this._getMaps(envFrom);
    let data = envFrom.map((e) => { return e.data ? e.data : []; }); // data = [data{}, ...]
    data.forEach((e) => {
      if (e) {
        Object.assign(result, e);
      }
    });

    let env = objectPath.get(this.data, `object.${path.replace(/^\.*|\.*$|(\.envFrom\.*$)|(\.env\.*$)/g, '')}.env`, []);
    await Promise.all(env.map(async (e) => {
      let name = e.name;
      let optional = objectPath.get(e, 'optional', false);
      let defaultValue = objectPath.get(e, 'default');
      if (e.value) {
        result[name] = e.value;
      } else if (e.valueFrom) {
        let value = await this._lookupDataReference(e.valueFrom);
        if (!value && !defaultValue) {
          let msg = `${JSON.stringify(e.valueFrom)} not found: optional=${optional}`;
          if (!optional) {
            throw new Error(msg);
          } else {
            log.info(msg);
          }
        } else {
          if (value) {
            result[name] = value;
          } else if (defaultValue) {
            result[name] = defaultValue;

            let msg = `${JSON.stringify(e.valueFrom)} not found. Using default value.`;
            log.info(msg);
          }
        }
      }
    }));
    return result;
  }
};
