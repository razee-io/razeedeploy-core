/*
 * Copyright 2019 IBM Corp. All Rights Reserved.
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
const merge = require('deepmerge');


module.exports = class BaseController {
  constructor(params) {

    this._finalizerString = params.finalizerString;

    this._logger = params.logger;
    this._kubeResourceMeta = params.kubeResourceMeta;
    this._kc = params.kubeClass;

    this._data = params.eventData;
    this._status = {};

    this._continueExecution = true;
  }

  // getters
  get log() {
    return this._logger;
  }
  get kubeResourceMeta() {
    return this._kubeResourceMeta;
  }
  get kubeClass() {
    return this._kc;
  }
  get data() {
    return this._data;
  }
  get status() {
    return this._status;
  }
  get name() {
    return objectPath.get(this._data, ['object', 'metadata', 'name']);
  }
  get namespace() {
    return objectPath.get(this._data, ['object', 'metadata', 'namespace']);
  }
  get continueExecution() {
    return this._continueExecution;
  }


  // Start processesing the data
  async execute() {
    try {
      if (!(this._data || this._data.type)) {
        throw Error('Unrecognized object recieved from watch event');
      }
      this._logger.info(`${this._data.type} event recieved ${objectPath.get(this._data, 'object.metadata.selfLink')} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      if (this._data.type === 'ADDED') {
        await this._added();
      } else if (this._data.type === 'POLLED') {
        await this._added();
      } else if (this._data.type === 'MODIFIED') {
        await this._modified();
      } else if (this._data.type === 'DELETED') {
        await this._deleted();
      }
    } catch (e) {
      this.errorHandler(e);
      objectPath.set(this._status, 'fatal', e.message || e);
      try {
        await this.patchSelf({ status: this._status }, { status: true });
      } catch (e) {
        this._logger.error(e);
      }
    }
  }

  errorHandler(err) {
    this._logger.error(err, this._data);
  }

  // the handler calls the underscored event function to allow pre/post processesing
  // around the normal event function that should be overriden in the subclass
  async _added() {
    let selfLink = objectPath.get(this._data, 'object.metadata.selfLink');
    this._logger.debug(`Finalizer ${selfLink}`);
    let deletionTimestamp = await this.finalizer();
    this._logger.debug(`Finalizer ${selfLink}: deletionTimestamp ${deletionTimestamp}, continueExecution ${this.continueExecution}`);
    if (!this.continueExecution) {
      return;
    } else if (deletionTimestamp) {
      return await this._patchStatus();
    }
    this._logger.debug(`added() ${selfLink}`);
    await this.added();
    this._logger.debug(`added() completed ${selfLink}`);
    if (!this.continueExecution) {
      return;
    }
    return await this._patchStatus();
  }
  async added() {
    this._logger.info(this._data);
  }

  async _modified() {
    await this.modified();
  }
  async modified() {
    await this._added();
  }

  async _deleted() {
    this.deleted();
  }
  async deleted() {
    this._logger.info(this._data);
  }

  // Finalizer Functions
  async finalizer() {
    let hasDeletionTimestamp = objectPath.has(this._data, 'object.metadata.deletionTimestamp');

    if (!this._finalizerString) {
      // we don't have a finalizer we care about, return
      return hasDeletionTimestamp;
    }

    let finalizers = objectPath.get(this._data, 'object.metadata.finalizers', []);
    let finalizerIndex = finalizers.indexOf(this._finalizerString);
    // if the object has been requested to be deleted
    if (hasDeletionTimestamp) {
      // if finalizer array contains our finalizer
      if (!this._finCleanRunning && finalizerIndex > -1) {
        this._finCleanRunning = true;
        try {
          this._logger.debug(`FinalizerCleanup ${objectPath.get(this._data, 'object.metadata.selfLink')}`);
          await this.finalizerCleanup(); // if finalizerCleanup completes without error then continue
          this._logger.debug(`FinalizerCleanup Completed ${objectPath.get(this._data, 'object.metadata.selfLink')}`);
          // remove finalizer from array
          finalizers.splice(finalizerIndex, 1);
          // apply updated resource
          await this.patchSelf([{ op: 'add', path: '/metadata/finalizers', value: finalizers }]);
        } catch (e) {
          // finalizerCleanup completed with errors, will try again next event
          this._logger.error(e);
          objectPath.set(this._status, 'fatal', e.message || e);
          await this.patchSelf({ status: this._status }, { status: true });
        }
        this._finCleanRunning = false;
      }
    } else { // resource has not been requested to be deleted
      // if finalizer doesnt exist yet
      if (finalizerIndex < 0) {
        // add finalizer for future checks
        finalizers.push(this._finalizerString);
        // apply updated resource
        await this.patchSelf([{ op: 'add', path: '/metadata/finalizers', value: finalizers }]);
      }
    }

    return hasDeletionTimestamp;
  }

  async finalizerCleanup() {
    // if cleanup fails, do not return successful response => Promise.reject(err) or throw Error(err).
    // if the kube patch to remove the finalizer from the array fails, this function will be called again,
    // be able to handle a second call (even after a successful cleanup)
    this._logger.info('finalizer cleanup: no action taken');
  }


  // Update own status helpers ===========================================
  updateStatus(newStatus) { // { path: . seperated String || [String ...], status: String || Object } || [{ path: String || [Strings], status: String || Object } ...]
    if (Array.isArray(newStatus)) {
      newStatus.forEach(s => {
        try {
          let path = this._sanitize(s.path, this._status);
          objectPath.set(this._status, path, s.status);
          s.result = { success: true };
        } catch (e) {
          s.result = { success: false, message: e };
        }
      });
    } else {
      try {
        let path = this._sanitize(newStatus.path, this._status);
        objectPath.set(this._status, path, newStatus.status);
        newStatus.result = { success: true };
      } catch (e) {
        newStatus.result = { success: false, message: e };
      }
    }
    return newStatus;
  }

  async _patchStatus() {
    objectPath.set(this._status, 'fatal', null);
    objectPath.set(this._status, 'error', null);
    objectPath.set(this._status, 'warn', null);
    return await this.patchSelf({ status: this._status }, { status: true });
  }
  // ===========================================

  // Patch creation helpers ===========================================
  _sanitize(path, object) {
    path = Array.isArray(path) ? clone(path) : path.split('.');
    let dashIndex = path.indexOf('-');
    while (dashIndex >= 0) {
      let arr = objectPath.get(object, path.slice(0, dashIndex), []);
      if (Array.isArray(arr)) {
        path[dashIndex] = arr.length;
      } else {
        throw Error(`Non valid path, can not append to ${JSON.stringify(arr)}`);
      }
      dashIndex = path.indexOf('-');
    }
    return path;
  }

  async patchSelf(patchObject, options = {}) {
    if (typeof patchObject !== 'object') {
      return Promise.reject('Patch requires an Object or an Array');
    }

    let originalRv = objectPath.get(this._data, 'object.metadata.resourceVersion');

    let res;
    if (Array.isArray(patchObject)) {
      res = await this._kubeResourceMeta.patch(this.name, this.namespace, patchObject, { status: options.status });
    } else {
      res = await this._kubeResourceMeta.mergePatch(this.name, this.namespace, patchObject, { status: options.status });
    }
    let rv = objectPath.get(res, 'metadata.resourceVersion');
    let deletionTimestamp = objectPath.has(res, 'metadata.deletionTimestamp');

    if (originalRv !== rv) {
      this._logger.debug(`ResourceVersion has changed due to self update ... ${originalRv} => ${rv} ... stopping execution`);
      this._continueExecution = false;
    } else if (deletionTimestamp) {
      this._logger.debug('DeletionTimestamp exists during self update ... stopping execution');
      this._continueExecution = false;
    }
    return this._continueExecution;
  }

  buildPatch(path, value, object) {
    let data = object || objectPath.get(this._data, 'object', {});
    path = this._sanitize(path, data);
    let jsonPatch = [];
    let patchTemplate = { op: 'add', path: undefined, value: undefined };

    do {
      let copy = clone(patchTemplate);
      copy.path = `/${path.join('/')}`;
      copy.value = value;
      let popped = path.pop();
      value = Number.isInteger(popped) ? [] : {};
      jsonPatch.unshift(copy);
    } while (!objectPath.has(data, path));
    return jsonPatch;
  }
  // ===========================================

  // kube api helper functions
  async replace(krm, file, options = {}) {
    let name = objectPath.get(file, 'metadata.name');
    let namespace = objectPath.get(file, 'metadata.namespace');
    let uri = krm.uri({ name: name, namespace: namespace, status: options.status });
    this._logger.debug(`Replace ${uri}`);
    let response = {};
    let opt = { simple: false, resolveWithFullResponse: true };
    let liveMetadata;
    this._logger.debug(`Get ${uri}`);
    let get = await krm.get(name, namespace, opt);
    if (get.statusCode === 200) {
      liveMetadata = objectPath.get(get, 'body.metadata');
      this._logger.debug(`Get ${get.statusCode} ${uri}: resourceVersion ${objectPath.get(get, 'body.metadata.resourceVersion')}`);
    } else if (get.statusCode === 404) {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
    } else {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
      return Promise.reject({ statusCode: get.statusCode, body: get.body });
    }

    if (liveMetadata) {
      if (options.hard !== true) {
        // merge metadata so things like finalizers/uid/etc. dont get lost
        let mergeMetadata = merge(liveMetadata, objectPath.get(file, 'metadata'), { arrayMerge: combineMerge });
        objectPath.set(file, 'metadata', mergeMetadata);
      } // else hard == true means use exactly the file as given, dont try to merge with live file
      if (options.force !== false) { // if force == true then replace file RV with live RV before apply
        objectPath.set(file, 'metadata.resourceVersion', objectPath.get(liveMetadata, 'resourceVersion'));
      } // else let the original file rv(if it existed) stay merged ontop of the live rv

      this._logger.debug(`Put ${uri}`);
      let put = await krm.put(file, opt);
      if (!(put.statusCode === 200 || put.statusCode === 201)) {
        this._logger.debug(`Put ${put.statusCode} ${uri}`);
        return Promise.reject({ statusCode: put.statusCode, body: put.body });
      } else {
        this._logger.debug(`Put ${put.statusCode} ${uri}`);
        response = { statusCode: put.statusCode, body: put.body };
      }
    } else {
      this._logger.debug(`Post ${uri}`);
      let post = await krm.post(file, opt);
      if (!(post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202)) {
        this._logger.debug(`Post ${post.statusCode} ${uri}`);
        return Promise.reject({ statusCode: post.statusCode, body: post.body });
      } else {
        this._logger.debug(`Post ${post.statusCode} ${uri}`);
        response = { statusCode: post.statusCode, body: post.body };
      }
    }
    return response;
  }

  reconcileFields(config, lastApplied, parentPath = []) {
    // Nulls fields that existed in kapitan.razee.io/last-applied-configuration but not the new file to be applied
    // this has the effect of removing the field from the liveResource
    Object.keys(lastApplied).forEach(key => {
      let path = clone(parentPath);
      path.push(key);
      if (!objectPath.has(config, path)) {
        objectPath.set(config, path, null);
      } else if (typeof lastApplied[key] == 'object' && !Array.isArray(lastApplied[key])) {
        this.reconcileFields(config, lastApplied[key], path);
      }
    });
  }

  async apply(krm, file, options = {}) {
    let name = objectPath.get(file, 'metadata.name');
    let namespace = objectPath.get(file, 'metadata.namespace');
    let uri = krm.uri({ name: objectPath.get(file, 'metadata.name'), namespace: objectPath.get(file, 'metadata.namespace') });
    this._logger.debug(`Apply ${uri}`);
    let opt = { simple: false, resolveWithFullResponse: true };
    let liveResource;
    let get = await krm.get(name, namespace, opt);
    if (get.statusCode === 200) {
      liveResource = objectPath.get(get, 'body');
      this._logger.debug(`Get ${get.statusCode} ${uri}: resourceVersion ${objectPath.get(get, 'body.metadata.resourceVersion')}`);
    } else if (get.statusCode === 404) {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
    } else {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
      return Promise.reject({ statusCode: get.statusCode, body: get.body });
    }

    if (liveResource) {
      let lastApplied = objectPath.get(liveResource, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration']);
      if (!lastApplied) {
        this.log.warn(`${uri}: No kapitan.razee.io/last-applied-configuration found`);
        objectPath.set(file, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration'], JSON.stringify(file));
      } else {
        lastApplied = JSON.parse(lastApplied);

        let original = clone(file);
        this.reconcileFields(file, lastApplied);
        objectPath.set(file, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration'], JSON.stringify(original));
      }
      if (objectPath.get(options, 'mode', 'MergePatch').toLowerCase() == 'strategicmergepatch') {
        let res = await krm.strategicMergePatch(name, namespace, file, opt);
        this._logger.debug(`strategicMergePatch ${res.statusCode} ${uri}`);
        if (res.statusCode === 415) {
          // let fall through
        } else if (res.statusCode < 200 || res.statusCode > 300) {
          return Promise.reject({ statusCode: res.statusCode, body: res.body });
        } else {
          return { statusCode: res.statusCode, body: res.body };
        }
      }
      let res = await krm.mergePatch(name, namespace, file, opt);
      this._logger.debug(`mergePatch ${res.statusCode} ${uri}`);
      if (res.statusCode < 200 || res.statusCode > 300) {
        return Promise.reject({ statusCode: res.statusCode, body: res.body });
      } else {
        return { statusCode: res.statusCode, body: res.body };
      }
    } else {
      this._logger.debug(`Post ${uri}`);
      let post = await krm.post(file, opt);
      if (!(post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202)) {
        this._logger.debug(`Post ${post.statusCode} ${uri}`);
        return Promise.reject({ statusCode: post.statusCode, body: post.body });
      } else {
        this._logger.debug(`Post ${post.statusCode} ${uri}`);
        return { statusCode: post.statusCode, body: post.body };
      }
    }
  }

  async ensureExists(krm, file, options = {}) {
    let name = objectPath.get(file, 'metadata.name');
    let namespace = objectPath.get(file, 'metadata.namespace');
    let uri = krm.uri({ name: name, namespace: namespace, status: options.status });
    this._logger.debug(`EnsureExists ${uri}`);
    let response = {};
    let opt = { simple: false, resolveWithFullResponse: true };

    let get = await krm.get(name, namespace, opt);
    if (get.statusCode === 200) {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
      return { statusCode: get.statusCode, body: get.body };
    } else if (get.statusCode === 404) { // not found -> must create
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
    } else {
      this._logger.debug(`Get ${get.statusCode} ${uri}`);
      return Promise.reject({ statusCode: get.statusCode, body: get.body });
    }

    this._logger.debug(`Post ${uri}`);
    let post = await krm.post(file, opt);
    if (post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202) {
      this._logger.debug(`Post ${post.statusCode} ${uri}`);
      return { statusCode: post.statusCode, body: post.body };
    } else if (post.statusCode === 409) { // already exists
      this._logger.debug(`Post ${post.statusCode} ${uri}`);
      response = { statusCode: 200, body: post.body };
    } else {
      this._logger.debug(`Post ${post.statusCode} ${uri}`);
      return Promise.reject({ statusCode: post.statusCode, body: post.body });
    }
    return response;
  }
  // ===========================================

}; // end of BaseController


// DeepMerge's ArrayMerge helpers
const emptyTarget = value => Array.isArray(value) ? [] : {};
const mergeClone = (value, options) => merge(emptyTarget(value), value, options);

function combineMerge(target, source, options) {
  const destination = target.slice();

  source.forEach(function (e, i) {
    if (typeof destination[i] === 'undefined') {
      const cloneRequested = options.clone !== false;
      const shouldClone = cloneRequested && options.isMergeableObject(e);
      destination[i] = shouldClone ? mergeClone(e, options) : e;
    } else if (options.isMergeableObject(e)) {
      destination[i] = merge(target[i], e, options);
    } else if (target.indexOf(e) === -1) {
      destination.push(e);
    }
  });
  return destination;
}
// ===========================================
