/**
 * Copyright 2022 IBM Corp. All Rights Reserved.
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

/**
 * ReferencedResourceManager creates and manages watches for Source Resources
 * based on events received for Parent Resources.
 *
 * When events are received from these Source Resource watches the manager
 * updates a label on the Parent Resources, triggering them to reprocess.
 */

const objectPath = require('object-path');
const fs = require('fs-extra');
const hash = require('object-hash');

const LRU = require('lru-cache');
const LruOptions = {
  max: 10000, // the number of most recently parent - child relation items to keep.
};
const sourceInfoCache = new LRU( LruOptions );
const sourceWatchCache = new LRU( LruOptions );


const KubernetesUtil = require('@razee/kubernetes-util');
const WatchManager = KubernetesUtil.WatchManager();
const FetchEnvs = require('./FetchEnvs.js');

module.exports = class ReferencedResourceManager {
  constructor(params) {
    this._logger = params.logger;
    this._kubeResourceMeta = params.kubeResourceMeta;
    this._kc = params.kubeClass;
    this._data = params.eventData;
    this._name = objectPath.get(this._data, 'object.metadata.name');
    this._namespace = objectPath.get(this._data, 'object.metadata.namespace');
    this._apiVersion = objectPath.get(this._data, 'object.apiVersion');
    this._resourceVersion = objectPath.get(this._data, 'object.metadata.resourceVersion');
    this._selfLink = this._kubeResourceMeta.uri({
      name: this._name,
      namespace: this._namespace
    });
    this._simpleLink = `${this._apiVersion}:${this._kubeResourceMeta.kind}/${this._namespace}/${this._name}`;
    this._managedResourceType = params.managedResourceType;
    this._parentKrm = params.parentKrm;
    this._razeeLogHashes = [];
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

  // Start processesing the data
  async execute() {
    try {
      if (!(this._data || this._data.type)) {
        throw Error('Unrecognized object received from watch event');
      }
      if (!(this._data.type)) {
        throw Error('No Data Type for object received from watch event');
      }

      this._logger.info(`${this._data.type} event received ${this._selfLink} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);

      let clusterLocked = await this._cluster_locked();
      if (clusterLocked) {
        this._logger.info(`Cluster lock has been set.. skipping ${this._data.type} event ${this._selfLink} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
        await this.updateRazeeLogs('info', { 'cluster-locked': clusterLocked });
        return await this._reconcileRazeeLogs();
      }


      if (this._data.type === 'ADDED') {
        await this._added();
      } else if (this._data.type === 'POLLED') {
        this._logger.info('-------POLLED');
        //await this._added();
      } else if (this._data.type === 'MODIFIED') {
        await this._modified();
      } else if (this._data.type === 'DELETED') {
        await this._deleted();
      } else {
        this._logger.info('-------UNKNOWN ACTION');
      }
    } catch (e) {
      try {
        this.errorHandler(e);
      } catch (e) {
        this._logger.error(e);
      }
    }
  }

  errorHandler(err) {
    if (typeof err === 'object' && !(err instanceof Error)) {
      try {
        err = JSON.stringify(err);
      } catch (error) {
        this._logger.error(`${this._selfLink}: failing to stringify error object - ${error}`);
      }
    }
    this._logger.error(`${this._selfLink}: ${err.toString()}`);
  }

  async added() {
    if ( this._managedResourceType === 'parent' )
    {
      let fetchEnvs = new FetchEnvs(this);
      let envSources = await fetchEnvs.getSourceSimpleLinks('spec');
      let lastUpdateTimestamp = `${new Date().getTime()}`;
      for (const sourceKind of Object.keys(envSources)){
        let currentSourceList = [];
        if (! sourceWatchCache.has(sourceKind)){//sourceKind not in watch cache
          let sourceApiVersion = envSources[sourceKind][0].split(':')[0];
          let resourceKrm = await this._kc.getKubeResourceMeta(sourceApiVersion, sourceKind, 'watch');
          let sourceWatchEntry = { watch: this.createWatch(resourceKrm), sources: envSources[sourceKind] };
          sourceWatchCache.set(sourceKind, sourceWatchEntry);
        }
        else {//sourceKind is in watch cache
          let sourceWatchEntry = sourceWatchCache.get(sourceKind);
          currentSourceList = sourceWatchEntry.sources;

          for (const sourceSimpleLink of envSources[sourceKind])
          {
            if(! (currentSourceList.includes(sourceSimpleLink)))
            {
              currentSourceList = [ ...currentSourceList, sourceSimpleLink ];
            }
          }
          sourceWatchEntry.sources = currentSourceList;
          sourceWatchCache.set(sourceKind, sourceWatchEntry);
        }
        for (const sourceSimpleLink of envSources[sourceKind])
        {
          if (sourceInfoCache.has(sourceSimpleLink))//source in sourceList
          {
            let sourceInfoEntry = sourceInfoCache.get(sourceSimpleLink);
            if( ! sourceInfoEntry.parents.includes(this._selfLink))
            {
              sourceInfoEntry.parents = [...sourceInfoEntry.parents, this._selfLink];
              sourceInfoCache.set(sourceSimpleLink, sourceInfoEntry);
            }
          }
          else{//source not in sourceList
            let sourceInfoEntry = { parents: [this._selfLink], lastUpdateTimestamp: lastUpdateTimestamp, resourceVersion: -1 };
            sourceInfoCache.set(sourceSimpleLink, sourceInfoEntry);
          }
        }
      }
    }
    else{
      if (sourceInfoCache.has(this._simpleLink)){
        let sourceData = sourceInfoCache.get(this._simpleLink);
        let parentResourceSelfLinks = sourceData.parents;
        if (parentResourceSelfLinks){
          if( this._resourceVersion > sourceData.resourceVersion)
          {
            for (const parentSelfLink of parentResourceSelfLinks){
              await this.updateParentSourceTimestamp(parentSelfLink);
            }
            sourceData.resourceVersion = this._resourceVersion;
            sourceInfoCache.set(this._simpleLink, sourceData);
          }
        }
      }
    }
  }

  async modified() {
    return await this.added();
  }

  async deleted() {
    if ( this._managedResourceType === 'parent' )
    {
      let fetchEnvs = new FetchEnvs(this);
      let envSources = await fetchEnvs.getSourceSimpleLinks('spec');
      for (const sourceKind of Object.keys(envSources)){
        let currentSourceList = {};
        let sourceWatchEntry = sourceWatchCache.get(sourceKind);
        currentSourceList = sourceWatchEntry.sources;

        for (const sourceSimpleLink of envSources[sourceKind])
        {
          if (sourceInfoCache.has(sourceSimpleLink))
          {
            let sourceData = sourceInfoCache.get(sourceSimpleLink);
            let sourceParentList = sourceData.parents;
            if (sourceParentList.includes(this._selfLink))
            {
              const parentKeyIndex = sourceParentList.indexOf(this._selfLink);
              sourceParentList.splice(parentKeyIndex,1);
              if( sourceParentList.length > 0) //If source still has parents after removing this parent update sourceParentList
              {
                sourceData.parents = sourceParentList;
                sourceInfoCache.set(sourceSimpleLink, sourceData);
              }
              else{ //If source has no parents after parent removal then remove this source
                sourceInfoCache.delete(sourceSimpleLink);
              }
            }
          }

          if (currentSourceList.includes(sourceSimpleLink) && ! sourceInfoCache.has(sourceSimpleLink)) //Remove source if it is in watch sourceList but not sourceInfoCache
          {
            const sourceIndex = currentSourceList.indexOf(sourceSimpleLink);
            currentSourceList.splice(sourceIndex,1);
          }
          if( currentSourceList.length > 0) //If removed source was not last source of this kind update sourceList
          {
            sourceWatchEntry.sources = currentSourceList;
            sourceWatchCache.set(sourceKind, sourceWatchEntry);
          }
          else{ //If removed source was last of its kind in sourceList remove the watch for this sourceKind
            this._logger.debug(`Attempting to remove watch: ${sourceKind}: ${JSON.stringify(sourceWatchEntry.watch.selfLink, null, ' ')}`);
            WatchManager.removeWatch(sourceWatchEntry.watch.selfLink);
            sourceWatchCache.delete(sourceKind);
          }
        }
        this._logger.debug(`Curren tWatches post delete: ${JSON.stringify(this.getCurrentWatches())}`);
      }
    }
    else{
      if(sourceInfoCache.has(this._simpleLink) && sourceInfoCache.get(this._simpleLink).parents)
      {
        for (const parentSelfLink of sourceInfoCache.get(this._simpleLink).parents){
          await this.updateParentSourceTimestamp(parentSelfLink);
        }
      }
    }
  }

  createWatch(resourceKrm, querySelector = {}, globalWatch = false)
  {
    let options = {
      logger: this._logger,
      requestOptions: {
        uri: resourceKrm.uri({ watch: true }),
        qs: querySelector
      }
    };
    let resourceWatch = WatchManager.ensureWatch(options, (data) => this.sourceEventHandler(data, resourceKrm), globalWatch);
    return resourceWatch;
  }

  async sourceEventHandler(data, resourceKrm)
  {
    let params = {
      kubeResourceMeta: resourceKrm.clone(),
      parentKrm: this._kubeResourceMeta.clone(),
      eventData: data,
      kubeClass: this._kc,
      logger: this._logger,
      managedResourceType: 'source'
    };
    const controller = new ReferencedResourceManager(params);
    return await controller.execute();
  }

  getCurrentWatches()
  {
    let currentWatchData = WatchManager.getAllWatches();
    let currentWatchSelfLinks = Object.keys(currentWatchData);
    return currentWatchSelfLinks;
  }

  async updateParentSourceTimestamp(parentResourceSelfLink) {
    if (parentResourceSelfLink){
      let sourceUpdateTimestamp = `${new Date().getTime()}`;
      let parentResourceNamespace = parentResourceSelfLink.split('namespaces/')[1].split('/')[0];
      let parentResourceName = parentResourceSelfLink.split('/').pop();
      let parentPatch = {
        metadata: {
          labels: {
            lastSourceUpdateTimestamp: sourceUpdateTimestamp
          }
        }
      };

      let opt = { simple: false, resolveWithFullResponse: true };
      let res = await this._parentKrm.mergePatch(parentResourceName, parentResourceNamespace, parentPatch, opt);

      this._logger.debug(`mergePatch ${res.statusCode} ${parentResourceSelfLink}`);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return Promise.reject({ statusCode: res.statusCode, body: res.body });
      } else {
        return { statusCode: res.statusCode, body: res.body };
      }
    }
  }




  //////INTERNALS

  // the handler calls the underscored event function to allow pre/post processesing
  // around the normal event function that should be overriden in the subclass
  async _added() {
    await this.added();
  }

  async _modified() {
    if ( this._managedResourceType !== 'parent' || !objectPath.has(this._data, ['object', 'metadata', 'annotations', 'deploy.razee.io/data-hash']))
    {
      await this.modified(); //Skip data hash check if not a Parent with razee data-hash field
    }
    else{
      // if data, deemed important, has changed (identified via the data hash), modified() should run
      let dh = objectPath.get(this._data, ['object', 'metadata', 'annotations', 'deploy.razee.io/data-hash']);
      let cdh = this._computeDataHash(objectPath.get(this._data, 'object'));
      if (dh != cdh) {
        this._logger.debug(`Last known deploy.razee.io/data-hash doesn't match computed.. updating annotation and running modified().. ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
        //await this.patchSelf({ metadata: { annotations: { 'deploy.razee.io/data-hash': cdh } } });
        await this.modified();
      } else { // else non significant change has occured, event is skipped
        this._logger.info(`No relevant change detected.. skipping ${this._data.type} event ${this._selfLink} ${objectPath.get(this._data, 'object.metadata.resourceVersion')}`);
      }
    }
  }

  async _deleted() {
    return await this.deleted();
  }
  // ===========================================


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
  // ===========================================


  // Patch creation helpers ===========================================
  async patchSelf(patchObject, options = {}) {
    if (typeof patchObject !== 'object') {
      return Promise.reject('Patch requires an Object or an Array');
    }
    const reqOpt = {};
    if (options.status === true) {
      reqOpt.status = options.status;
    }
    objectPath.set(reqOpt, 'headers.Impersonate-User', undefined); // no matter the user, always allow updates to self.

    let res;
    if (Array.isArray(patchObject)) {
      res = await this._kubeResourceMeta.patch(this._name, this._namespace, patchObject, reqOpt);
    } else {
      res = await this._kubeResourceMeta.mergePatch(this._name, this._namespace, patchObject, reqOpt);
    }

    return res;
  }
  // ===========================================
}; // end of ReferencedResourceManager
