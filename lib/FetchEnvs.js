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

const LRU = require('lru-cache');
const LruOptions = {
  maxSize: parseInt(process.env.FETCHENVS_CACHE_SIZE) || 100000, // the max cache size
  sizeCalculation: (r) => { return( JSON.stringify(r).length ); }, // how to determine the size of a resource added to the cache
  ttl: 1000 * 60 * 3,  // max time to cache (LRU does not directly enforce, but maxSize will eventually push them out)
  updateAgeOnGet: false,  // Don't update ttl when an item is retrieved from cache
  updateAgeOnHas: false,  // Don't update ttl when an item is checked in cache
};
const globalResourceCache = new LRU( LruOptions );
const globalResourceCacheUsers = new Set();
const singleResourceQueryCache = {};

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

    const user = this.data?.object?.spec?.clusterAuth?.impersonateUser;
    this.resourceCache = {
      has: (key) => {
        const hit = globalResourceCache.has(`${user}/${key}`);
        log.info( `FetchEnvs cache ${hit?'HIT':'MISS'}: '${user}/${key}'` );
        return hit;
      },
      set: (key, value) => {
        // When setting a key, keep track of users to allow later deletion
        globalResourceCacheUsers.add( user );
        globalResourceCache.set(`${user}/${key}`, value);
        log.info( `FetchEnvs cached '${user}/${key}'` );
      },
      get: (key) => {
        return globalResourceCache.get(`${user}/${key}`);
      },
    };
  }

  // This function needs to be called any time a watch on a potentially cached item is triggered by creation/update/poll, e.g. in the ReferencedResourceManager
  // If it is not, the old resource may still be served from cache until the TTL expires
  static updateInGlobalCache(resource) {
    const cacheKey = [resource?.apiVersion, resource?.kind, resource?.metadata?.namespace, resource?.metadata?.name].join('/');
    let updated = false;
    // When updating a key, updating it for all users
    for( const cacheUser of globalResourceCacheUsers ) {
      if( globalResourceCache.has(`${cacheUser}/${cacheKey}`) ) {
        globalResourceCache.set(`${cacheUser}/${cacheKey}`, resource);
        updated = true;
      }
    }
    if( updated ) log.info( `FetchEnvs cache updated for "*/${cacheKey}"` );
  }

  // This function needs to be called any time a watch on a potentially cached item is triggered by deletion, e.g. in the ReferencedResourceManager
  // If it is not, the deleted resource may still be served from cache until the TTL expires
  static deleteFromGlobalCache(resource) {
    const cacheKey = [resource?.apiVersion, resource?.kind, resource?.metadata?.namespace, resource?.metadata?.name].join('/');
    let deleted = false;
    // When deleting a key, delete it for all users
    for( const cacheUser of globalResourceCacheUsers ) {
      if( globalResourceCache.has(`${cacheUser}/${cacheKey}`) ) {
        globalResourceCache.delete(`${cacheUser}/${cacheKey}`);
        deleted = true;
      }
    }
    if( deleted ) log.info( `FetchEnvs cache deleted for "*/${cacheKey}"` );
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

  /*
  @param[I] conf An object like `{ configMapRef: { name: 'asdf', namespace: 'asdf' } }`.
  @param[I] valueFrom The name of the conf attribute containing resource details, e.g. `configMapRef`.
  @param[I] decode A boolean indicating whether to base64 decode the values retrieved, e.g. from Secrets

  @return An object like { configMapRef: { name: 'asdf', namespace: 'asdf' }, data: { key1: val1, ... } }
  */
  async #genericMapRef(conf, valueFrom = 'genericMapRef', decode = false) {
    const ref = conf[valueFrom];
    const optional = !!conf.optional;

    const {
      apiVersion = 'v1',
      kind = KIND_MAP.get(valueFrom),
      namespace = this.namespace,
      name
    } = ref;

    const cacheKey = [apiVersion, kind, namespace, name].join('/');

    let kubeError = ERR_NODATA;
    let resource;

    // Single-resource queries are cacheable.  If it's in the cache, use it.
    if( this.resourceCache.has( cacheKey ) ) {
      resource = this.resourceCache.get( cacheKey );
    }
    // Single-resource queries are cacheable.  If not in the cache, start an api call to populate the cache if needed, wait for it to finish, then use it from the cache.
    else {
      if( !singleResourceQueryCache[cacheKey] ) {
        singleResourceQueryCache[cacheKey] = ( async () => {
          try {
            const krm = await this.kubeClass.getKubeResourceMeta( apiVersion, kind, 'update' );
            if (krm) {
              resource = await krm.get( name, namespace );
              if( resource ) {
                this.resourceCache.set( cacheKey, resource ); // Cache this resource
              }
            }
          }
          finally {
            delete singleResourceQueryCache[cacheKey];
          }
        } )();
      }

      try {
        await singleResourceQueryCache[cacheKey];
      }
      catch( error ) {
        kubeError = error;
      }

      resource = this.resourceCache.get( cacheKey );
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

  /*
  @param[I] conf An object like `{ default: '{default:true}', overrideStrategy: 'merge', configMapRef: { name: 'asdf', namespace: 'asdf', key: 'asdf', type: 'json' } }`
  - name, namespace, and matchLabels identify the resource
  - key identifies the data inside the resource
  - type identifies how to typecast the value

  @return The discovered value
  */
  async #genericKeyRef(conf, valueFrom = 'genericKeyRef', decode = false) {
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

    const matchLabelsQS = labelSelectors(matchLabels);

    const cacheKey = [apiVersion, kind, namespace, name].join('/');

    let kubeError = ERR_NODATA;
    let response;

    if( typeof matchLabelsQS === OBJECT ) {
      // MatchLabels queries are not cached (though the resulting resources are cached), alway the kube api call
      try {
        const krm = await this.kubeClass.getKubeResourceMeta(apiVersion, kind, 'update');

        if (krm) {
          response = await this.api({
            uri: krm.uri({ namespace, name }),
            json: true,
            qs: matchLabelsQS
          });
          // Cache multiple resources
          if( response?.items ) {
            response.items.forEach(function (item) {
              const cacheKey = [item.apiVersion, item.kind, item.metadata.namespace, item.metadata.name].join('/');
              this.resourceCache.set(cacheKey, item);
            }, this);
          }
        }
      } catch (error) {
        kubeError = error;
      }
    }
    // Single-resource queries are cacheable.  If in the cache, use it.
    else if( this.resourceCache.has( cacheKey ) ) {
      response = this.resourceCache.get( cacheKey );
    }
    // Single-resource queries are cacheable.  If not in the cache, start an api call to populate the cache if needed, wait for it to finish, then use it from the cache.
    else {
      if( !singleResourceQueryCache[cacheKey] ) {
        singleResourceQueryCache[cacheKey] = ( async () => {
          try {
            const krm = await this.kubeClass.getKubeResourceMeta( apiVersion, kind, 'update' );
            if (krm) {
              response = await krm.get( name, namespace );
              if( response ) {
                this.resourceCache.set( cacheKey, response ); // Cache this resource
              }
            }
          }
          finally {
            delete singleResourceQueryCache[cacheKey];
          }
        })();
      }

      try {
        await singleResourceQueryCache[cacheKey];
      }
      catch( error ) {
        kubeError = error;
      }

      response = this.resourceCache.get( cacheKey );
    }

    let value = response?.data?.[key];

    // If matching by labels, there can be multiple matching resources.
    // Reduce to a single value via the specified strategy ('merge' combines objects, otherwise a single value is picked).
    if (typeof matchLabelsQS === OBJECT) {
      const output = response?.items.reduce(
        reduceItemList(ref, strategy, decode),
        Object.create(null)
      );

      value = output?.[key];
      decode = false; // 'decode' was used in the reduceItemList, set to false to avoid double-decoding.
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

  /*
  Retrieve all values from specified kube resources.

  @param[I] envs Array of objects like `[ { configMapRef: { ... }, ... } ]`

  @return Array of objects like ``[ { configMapRef: { ... }, data: { key1: val1, key2: val2, ... } }, ... ]``
  */
  async processEnvFrom(envFrom) {
    const retVal = await Promise.all(envFrom.map((element) => {
      const { configMapRef, secretMapRef, genericMapRef } = element;

      if (!configMapRef && !secretMapRef && !genericMapRef) {
        throw new Error(`oneOf configMapRef, secretMapRef, genericMapRef must be defined. Got: ${JSON.stringify(element)}`);
      }

      if (configMapRef) return this.#configMapRef(element);
      if (secretMapRef) return this.#secretMapRef(element);
      return this.#genericMapRef(element);
    }));
    return( retVal );
  }

  /*
  Retrieve specific values from specified kube resources.

  Each env is retrieved and processed sequentially so that caching can take place.
  If Promise.all were used, multiple requests for the same resource would be sent
  in parallel and caching would be unable to assist.  The return value is an array
  as if from Promise.all.

  @param[I] envs Array of objects like `[ { configMapKeyRef: { ... }, ... } ]`

  @return Array of objects like `[ { configMapKeyRef: { ... }, value: asdf }, ... ]`
  */
  async #processEnv(envs) {
    const retVal = [];
    for( const env of envs ) {
      if (env.value) {
        retVal.push( env );
      }
      else {
        const valueFrom = env.valueFrom || {};
        const { genericKeyRef, configMapKeyRef, secretKeyRef } = valueFrom;

        if (!genericKeyRef && !configMapKeyRef && !secretKeyRef) {
          throw new Error(`oneOf genericKeyRef, configMapKeyRef, secretKeyRef must be defined. Got: ${JSON.stringify(env)}`);
        }

        let value;
        if (secretKeyRef) value = await this.#secretKeyRef(env);
        if (configMapKeyRef) value = await this.#configMapKeyRef(env);
        if (genericKeyRef) value = await this.#genericKeyRef(env);

        retVal.push( { ...env, value } );
      }
    }
    return retVal;
  }

  #processEnvSourceSimpleLinks(envs) {
    return Promise.all(envs.map(async (env) => {
      if (env.value) return env;
      const parentNamespace = this.namespace;
      if (env.valueFrom) return { ...env, parentNamespace };
      return { valueFrom: env, parentNamespace };
    }));
  }

  /*
  Retrieve values specified in spec.envFrom and spec.env elements

  @param[I] path path to the env and envFrom elements in the resource

  @return A map of keys to values
  */
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

    let env = objectPath.get(this.data, `object.${path}.env`, []);

    env = await this.#processEnv(env);
    return (env).reduce(reduceEnv, result);
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
    const sourceKind = objectPath.get( sourceValueFromInfo, 'kind', KIND_MAP.get(sourceRefType));
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

/*
Cast the specified value to the indicated type.  The value is returned unmodified if:
- 'type' is not specified
- 'value' is null or not a string

@param[I] name The name of the reference from which the value was obtained.  Used only in generating error text in case of JSON parsing errors.
@param[I] value The string value to typecast.
@param[I] type How to typecast the value.

@return Value, cast to the indicated type (e.g. number, boolean, json, base64 decoded string )
*/
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
