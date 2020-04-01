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
const fs = require('fs-extra');
const hash = require('object-hash');


module.exports = class BaseController {
  constructor(params) {

    this._finalizerString = params.finalizerString;

    this._logger = params.logger;
    this._kubeResourceMeta = params.kubeResourceMeta;
    this._kc = params.kubeClass;

    this._data = params.eventData;
    this._status = {}; // to be removed
    this._children = {};
    this._razeeLogHashes = [];
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
  get status() { // to be removed
    return this._status;
  }
  get children() {
    return this._children;
  }
  get name() {
    return objectPath.get(this._data, ['object', 'metadata', 'name']);
  }
  get namespace() {
    return objectPath.get(this._data, ['object', 'metadata', 'namespace']);
  }
  get reconcileDefault() {
    let result;
    result = objectPath.get(this._data, ['object', 'metadata', 'labels', 'deploy.razee.io/Reconcile']) ||
      objectPath.get(this._data, ['object', 'metadata', 'labels', 'kapitan.razee.io/Reconcile'], 'true');
    return result;
  }

  // Start processesing the data
  async execute() {
    try {
      if (!(this._data || this._data.type)) {
        throw Error('Unrecognized object received from watch event');
      }
      this._logger.info(`${this._data.type} event received ${objectPath.get(this._data, 'object.metadata.selfLink')} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      let clusterLocked = await this._cluster_locked();
      if (clusterLocked) {
        this._logger.info(`Cluster lock has been set.. skipping ${this._data.type} event ${objectPath.get(this._data, 'object.metadata.selfLink')} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
        await this.updateRazeeLogs('info', { 'cluster-locked': clusterLocked });
        return await this._reconcileRazeeLogs();
      }
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
      try {
        this.errorHandler(e);
        await this.updateRazeeLogs('error', e.message || e);
        await this._reconcileRazeeLogs();
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
    // should always keep data-hash up to date on added events to avoid conflict with modified events
    let dh = objectPath.get(this._data, ['object', 'metadata', 'annotations', 'deploy.razee.io/data-hash']);
    let cdh = this._computeDataHash(objectPath.get(this._data, 'object'));
    if (dh != cdh) {
      this._logger.debug(`Updating annotation deploy.razee.io/data-hash for ${this._data.type} event.. ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      let res = await this.patchSelf({ metadata: { annotations: { 'deploy.razee.io/data-hash': cdh } } });
      // save newly patched object to continue cycle with latest data
      objectPath.set(this._data, 'object', res);
    }

    let selfLink = objectPath.get(this._data, 'object.metadata.selfLink');
    this._logger.debug(`'Added' Finalizer ${selfLink} started`);
    let hasDeletionTimestamp = await this.finalizer();
    this._logger.debug(`'Added' Finalizer ${selfLink} completed: deletionTimestamp ${hasDeletionTimestamp}`);
    if (hasDeletionTimestamp) {
      if (objectPath.get(this._data, 'object.metadata.finalizers', []).length > 0) {
        try {
          await this._patchStatus(); // to be removed
          return await this._reconcileRazeeLogs();
        } catch (e) {
          return (e.statusCode === 404) ? { message: 'Resource already deleted', statusCode: 404 } : Promise.reject(e);
        }
      }
      return;
    }

    this._logger.debug(`added() ${selfLink}`);
    await this.added();
    this._logger.debug(`added() completed ${selfLink}`);

    await this._patchStatus(); // to be removed
    return await this._reconcileRazeeLogs();
  }
  async added() {
    return this._logger.info(this._data);
  }

  async _modified() {
    if (objectPath.has(this._data, 'object.metadata.deletionTimestamp')) {
      if (objectPath.get(this._data, ['object', 'status', 'deploy.razee.io/finalizer-cleanup']) == 'running') {
        this._logger.debug(`Found deletionTimestamp.. but finalizer already running.. skipping ${this._data.type} event ${objectPath.get(this._data, 'object.metadata.selfLink')} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
        return;
      }
      this._logger.debug(`Found deletionTimestamp.. running finalizer.. ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      this._logger.debug(`'Modified' Finalizer ${objectPath.get(this._data, 'object.metadata.selfLink')} started`);
      let hasDeletionTimestamp = await this.finalizer();
      this._logger.debug(`'Modified' Finalizer ${objectPath.get(this._data, 'object.metadata.selfLink')} completed: deletionTimestamp ${hasDeletionTimestamp}`);
      if (objectPath.get(this._data, 'object.metadata.finalizers', []).length > 0) {
        try {
          await this._patchStatus(); // to be removed
          return await this._reconcileRazeeLogs();
        } catch (e) {
          return (e.statusCode === 404) ? { message: 'Resource already deleted', statusCode: 404 } : Promise.reject(e);
        }
      }
      return;
    }

    // if data, deemed important, has changed (identified via the data hash), modified() should run
    let dh = objectPath.get(this._data, ['object', 'metadata', 'annotations', 'deploy.razee.io/data-hash']);
    let cdh = this._computeDataHash(objectPath.get(this._data, 'object'));
    if (dh != cdh) {
      this._logger.debug(`Last known deploy.razee.io/data-hash doesn't match computed.. updating annotation and running modified().. ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      await this.patchSelf({ metadata: { annotations: { 'deploy.razee.io/data-hash': cdh } } });
      await this.modified();
    } else { // else non significant change has occured, event is skipped
      this._logger.info(`No relevant change detected.. skipping ${this._data.type} event ${objectPath.get(this._data, 'object.metadata.selfLink')} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
    }
  }
  async modified() {
    return await this._added();
  }

  async _deleted() {
    return await this.deleted();
  }
  async deleted() {
    return this._logger.info(this._data);
  }

  // General helpers ===========================================
  async _cluster_locked() {
    let lockCluster = 'false';
    let lockClusterPath = './config/lock-cluster';
    let exists = await fs.pathExists(lockClusterPath);
    if (exists) {
      lockCluster = await fs.readFile(lockClusterPath, 'utf8');
      lockCluster = lockCluster.trim().toLowerCase();
    }
    return (lockCluster == 'true');
  }

  _computeDataHash(resource) {
    let importantData = this.dataToHash(resource);
    let dataHash = hash(importantData);
    return dataHash;
  }

  dataToHash(resource) {
    // Override if you have other data as important.
    // Changes to these sections cause modify event to proceed.
    return {
      labels: objectPath.get(resource, 'metadata.labels'),
      spec: objectPath.get(resource, 'spec')
    };
  }
  // ===========================================

  // Finalizer Functions ===========================================
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
      if (finalizerIndex > -1) {
        // mark resource to let modified() know finalizer cleanup started to avoid multiple events comming through and starting finalizer cleanup.
        let res = await this.patchSelf({ status: { 'deploy.razee.io/finalizer-cleanup': 'running' } }, { status: true });
        // save newly patched object to continue cycle with latest data
        objectPath.set(this._data, 'object', res);

        this._logger.debug(`FinalizerCleanup Started: ${objectPath.get(this._data, 'object.metadata.selfLink')}`);
        await this.finalizerCleanup(); // if finalizerCleanup completes without error then continue
        this._logger.debug(`FinalizerCleanup Completed: ${objectPath.get(this._data, 'object.metadata.selfLink')}`);
        // remove finalizer from array
        finalizers.splice(finalizerIndex, 1);
        try {
          // apply updated resource. If another finalizer exists and gets deleted before this patch is complete, kube will error based on trying to add
          // a "new" finalzier, because we dont have the updated finalizer list with the deleted one removed. We will attempt patch again next cycle.
          let res = await this.patchSelf({ metadata: { finalizers: finalizers } });
          // save newly patched object to continue cycle with latest data
          objectPath.set(this._data, 'object', res);
        } catch (e) {
          // if patch to remove finalizer fails (will fail if resourceVersion has changed 409 or resource already deleted 404), this will reject out and try again next cycle if necessary.
          return (e.statusCode === 404) ? { message: 'Resource already deleted', statusCode: 404 } : Promise.reject(e);
        }
      }
    } else { // resource has not been requested to be deleted
      // if finalizer doesnt exist yet
      if (finalizerIndex < 0) {
        // add finalizer for future checks
        finalizers.push(this._finalizerString);
        // apply updated resource
        // if patch to add finalizer fails (will fail if resourceVersion has changed 409), this will reject out and try again next cycle.
        let res = await this.patchSelf({ metadata: { resourceVersion: objectPath.get(this._data, 'object.metadata.resourceVersion'), finalizers: finalizers } });
        // save newly patched object to continue cycle with latest data
        objectPath.set(this._data, 'object', res);
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
  // ===========================================

  // Update own status helpers ===========================================
  async updateRazeeLogs(logLevel, log) { // add new log to razee logs in status
    let patchObj = {};
    let logHash = hash(log);
    objectPath.set(patchObj, ['razee-logs', logLevel, logHash], log);
    this._razeeLogHashes.push(logHash);

    let res = await this.patchSelf({ status: patchObj }, { status: true });
    // save newly patched object to continue cycle with latest data
    objectPath.set(this._data, 'object', res);
    return res;
  }

  async _reconcileRazeeLogs() { // clear out logs in status that weren't created this cycle
    let patchObj = {};
    let logLevels = Object.keys(objectPath.get(this._data, 'object.status.razee-logs', {}));
    logLevels.map(logLevel => {
      let logHashes = Object.keys(objectPath.get(this._data, ['object', 'status', 'razee-logs', logLevel], {}));
      logHashes.map(logHash => {
        this._razeeLogHashes.includes(logHash) ?
          objectPath.set(patchObj, ['razee-logs', logLevel, logHash], objectPath.get(this._data, ['object', 'status', 'razee-logs', logLevel, logHash])) :
          objectPath.set(patchObj, ['razee-logs', logLevel, logHash], null);
      });
      let logLevelIsEmpty = Object.values(objectPath.get(patchObj, ['razee-logs', logLevel], {})).every(x => (x == null));
      if (logLevelIsEmpty) {
        objectPath.set(patchObj, ['razee-logs', logLevel], null);
      }
    });
    let razeeLogsIsEmpty = Object.values(objectPath.get(patchObj, ['razee-logs'], {})).every(x => (x == null));
    if (razeeLogsIsEmpty) {
      objectPath.set(patchObj, ['razee-logs'], null);
    }

    let res = await this.patchSelf({ status: patchObj }, { status: true });
    // save newly patched object to continue cycle with latest data
    objectPath.set(this._data, 'object', res);
    return res;
  }

  // to be removed
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

  // to be removed
  async _patchStatus() {
    let patchObj = {
      fatal: null,
      error: null,
      warn: null,
      info: null
    };
    merge(this._status, patchObj);
    let res = await this.patchSelf({ status: this._status }, { status: true });
    // save newly patched object to continue cycle with latest data
    objectPath.set(this._data, 'object', res);
    return res;
  }
  // ===========================================

  // Patch creation helpers ===========================================
  async patchSelf(patchObject, options = {}) {
    if (typeof patchObject !== 'object') {
      return Promise.reject('Patch requires an Object or an Array');
    }

    let res;
    if (Array.isArray(patchObject)) {
      res = await this._kubeResourceMeta.patch(this.name, this.namespace, patchObject, { status: options.status });
    } else {
      res = await this._kubeResourceMeta.mergePatch(this.name, this.namespace, patchObject, { status: options.status });
    }

    return res;
  }

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
    // Nulls fields that existed in deploy.razee.io/last-applied-configuration but not the new file to be applied
    // this has the effect of removing the field from the liveResource
    Object.keys(lastApplied).forEach(key => {
      let path = clone(parentPath);
      path.push(key);
      if (!objectPath.has(config, path)) {
        objectPath.set(config, path, null);
      } else if (lastApplied[key] && typeof lastApplied[key] == 'object' && !Array.isArray(lastApplied[key])) {
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
      let debug = objectPath.get(liveResource, ['metadata', 'labels', 'deploy.razee.io/debug']) ||
        objectPath.get(liveResource, ['metadata', 'labels', 'kapitan.razee.io/debug'], 'false');
      if (debug.toLowerCase() === 'true') {
        return { statusCode: 200, body: liveResource };
      }
      let lastApplied = objectPath.get(liveResource, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration']) ||
        objectPath.get(liveResource, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration']);
      if (!lastApplied) {
        this.log.warn(`${uri}: No deploy.razee.io/last-applied-configuration found`);
        objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(file));
      } else {
        lastApplied = JSON.parse(lastApplied);

        let original = clone(file);
        this.reconcileFields(file, lastApplied);
        objectPath.set(file, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration'], null);
        objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(original));
      }
      if (objectPath.get(options, 'mode', 'MergePatch').toLowerCase() == 'strategicmergepatch') {
        let res = await krm.strategicMergePatch(name, namespace, file, opt);
        this._logger.debug(`strategicMergePatch ${res.statusCode} ${uri}`);
        if (res.statusCode === 415) {
          // let fall through
        } else if (res.statusCode < 200 || res.statusCode >= 300) {
          return Promise.reject({ statusCode: res.statusCode, body: res.body });
        } else {
          return { statusCode: res.statusCode, body: res.body };
        }
      }
      let res = await krm.mergePatch(name, namespace, file, opt);
      this._logger.debug(`mergePatch ${res.statusCode} ${uri}`);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return Promise.reject({ statusCode: res.statusCode, body: res.body });
      } else {
        return { statusCode: res.statusCode, body: res.body };
      }
    } else {
      this._logger.debug(`Post ${uri}`);
      // Add last-applied to be used in future apply reconciles
      objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(file));
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
