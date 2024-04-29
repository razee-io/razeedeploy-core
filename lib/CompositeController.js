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


/*
 * CompositeController extends BaseController adding the ability to generate,
 * track and reconcile child resources.
 */

const objectPath = require('object-path');
const clone = require('clone');
const yaml = require('js-yaml');

const BaseController = require('./BaseController');

const moduleName = 'razeedeploy-core.lib.CompositeController';

module.exports = class CompositeController extends BaseController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.compositecontroller.deploy.razee.io';
    super(params);
  }

  async finalizerCleanup() {
    const methodName = `${moduleName}.finalizerCleanup()`;
    this.log.info(`${methodName} entry`);

    // if cleanup fails, do not return successful response => Promise.reject(err) or throw Error(err)
    let children = objectPath.get(this.data, ['object', 'status', 'children'], {});
    let res = await Promise.all(Object.entries(children).map(async ([selfLink, child]) => {
      try {
        let reconcile = objectPath.get(child, ['deploy.razee.io/Reconcile'], this.reconcileDefault);
        if (reconcile.toLowerCase() == 'true') {
          // If child is to be Reconciled, delete it
          this.log.info(`${methodName} finalizer: ${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. removing from cluster`);
          await this._deleteChild(selfLink);
        }
        else {
          // If child is NOT to be Reconciled, remove the parent reference
          this.log.info(`${methodName} finalizer: ${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. leaving on cluster`);
          await this._patchChild(selfLink);
        }
        let res = await this.patchSelf({
          status: {
            children: {
              [selfLink]: null
            }
          }
        }, { status: true });
        objectPath.set(this.data, 'object', res);
      } catch (e) {
        return Promise.reject({ selfLink: selfLink, action: 'delete', state: 'fail', error: e.message || e });
      }
    }));
    return res;
  }

  async addChildren(children) {
    if (!Array.isArray(children)) {
      children = [children];
    }
    await Promise.all(children.map(async child => {
      let selfLink = child.selfLink;
      objectPath.del(child, 'selfLink');
      let res = await this.patchSelf({
        status: {
          children: {
            [selfLink]: child
          }
        }
      }, { status: true });
      objectPath.set(this.data, 'object', res); // save latest patch response
      objectPath.set(this.children, [selfLink], child); // save child to mem for cycle reconcile
    }));
  }

  async applyChild(child) {
    const methodName = `${moduleName}.applyChild(child)`;

    const childApiVersion = objectPath.get(child, 'apiVersion');
    const childKind = objectPath.get(child, 'kind');
    const childName = objectPath.get(child, 'metadata.name');
    let childNamespace = objectPath.get(child, 'metadata.namespace');
    let childUri = `${childApiVersion}/${childKind}/${childNamespace ? `namespace/${childNamespace}/` : ''}${childName}`;

    this.log.info(`${methodName} entry, childUri: ${childUri}`);

    if (!childApiVersion || !childKind) {
      return {
        statusCode: 400,
        body: {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message: `Invalid kubernetes resource, 'kind: ${childKind}' and 'apiVersion: ${childApiVersion}' must not be empty`,
          reason: 'BadRequest',
          details: { apiVersion: `${childApiVersion}`, kind: `${childKind}`, uri: childUri },
          code: 400
        }
      };
    }

    if (childApiVersion.toLowerCase() === 'v1' && childKind.toLowerCase() === 'list' && Array.isArray(child.items)) {
      try {
        let res = await Promise.all(child.items.map(async item => {
          let applyChildRes = await this.applyChild(item);
          if (!applyChildRes.statusCode || applyChildRes.statusCode < 200 || applyChildRes.statusCode >= 300) {
            return Promise.reject(applyChildRes);
          }
          return applyChildRes;
        }));
        return res[0];
      } catch (e) {
        return e;
      }
    }

    if (!childName) {
      return {
        statusCode: 400,
        body: {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message: `Invalid kubernetes resource, 'metadata.name: ${childName}' must not be empty`,
          reason: 'BadRequest',
          details: { apiVersion: `${childApiVersion}`, kind: `${childKind}`, uri: childUri },
          code: 400
        }
      };
    }

    let krm = await this.kubeClass.getKubeResourceMeta(childApiVersion, childKind, 'update');
    if (!krm) {
      return {
        statusCode: 404,
        body: {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message: `Unable to find kubernetes resource matching: ${childApiVersion}/${childKind}`,
          reason: 'NotFound',
          details: { apiVersion: `${childApiVersion}`, kind: `${childKind}`, uri: childUri },
          code: 404
        }
      };
    }

    let impersonateUser = this.processImpersonation(krm);

    let res;
    let reconcile = objectPath.get(child, ['metadata', 'labels', 'deploy.razee.io/Reconcile'], this.reconcileDefault);
    let mode = objectPath.get(child, ['metadata', 'labels', 'deploy.razee.io/mode'], 'Apply');
    let modeUsed = '';
    if (!objectPath.has(child, ['metadata', 'namespace']) && krm.namespaced) {
      objectPath.set(child, ['metadata', 'namespace'], this.namespace);
      childNamespace = objectPath.get(child, 'metadata.namespace');
    }
    childUri = krm.uri({ name: childName, namespace: childNamespace });
    let childUid = objectPath.get(res, 'body.metadata.uid');


    try {
      switch (mode.toLowerCase()) {
        case 'StrategicMergePatch'.toLowerCase():
          modeUsed = 'StrategicMergePatch';
          res = await this.apply(krm, child, { mode: 'StrategicMergePatch' });
          break;
        case 'AdditiveMergePatch'.toLowerCase():
          modeUsed = 'AdditiveMergePatch';
          res = await this.apply(krm, child, { mode: 'AdditiveMergePatch' });
          break;
        case 'EnsureExists'.toLowerCase():
          modeUsed = 'EnsureExists';
          res = await this.ensureExists(krm, child);
          break;
        default: // Apply - MergePatch
          modeUsed = 'Apply';
          res = await this.apply(krm, child);
      }
      if (res.body == 'Multiple Parents') {
        this.log.warn(`${methodName} Child already managed by another parent. Skipping addChildren for ${childUri}`);
      } else {
        this.log.info(`${methodName} patch successful, adding to children: ${modeUsed} ${res.statusCode} ${childUri}`);
        await this.addChildren({ uid: childUid, selfLink: childUri, 'deploy.razee.io/Reconcile': reconcile, 'Impersonate-User': impersonateUser });
      }
      this.log.info(`${methodName}  complete: ${childUri} -- ${res.statusCode}`);
    } catch (e) {
      this.log.warn(`${methodName}  error: ${childUri} -- ${e.message || e}`);
      res = e;
    }
    return res;
  }

  async reconcileChildren() {
    const methodName = `${moduleName}.reconcileChildren()`;

    let newChildren = this.children; // children that were computed this cycle
    let oldChildren = objectPath.get(this.data, ['object', 'status', 'children'], {}); // children that existed at the start of the cycle

    if (Object.entries(newChildren).length < Object.entries(oldChildren).length) {
      this.log.info(`${methodName} Less children found this cycle then previously (${Object.entries(newChildren).length} < ${Object.entries(oldChildren).length}).. ReconcileChildren called by ${objectPath.get(this.data, ['object', 'metadata', 'selfLink'])}`);
    }

    let res = await Promise.all(Object.entries(oldChildren).map(async ([selfLink, child]) => {
      const newChild = clone(child);
      let reconcile = objectPath.get(child, ['deploy.razee.io/Reconcile'], this.reconcileDefault);
      let exists = objectPath.has(newChildren, [selfLink]);
      if (!exists && reconcile.toLowerCase() == 'true') {
        this.log.info(`${methodName} ${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. removing from cluster`);
        try {
          await this._deleteChild(selfLink);
          let res = await this.patchSelf({
            status: {
              children: {
                [selfLink]: null
              }
            }
          }, { status: true });
          objectPath.set(this.data, 'object', res);
        } catch (e) {
          // if fail to delete, keep as a child until next cycle to retry
          newChild.action = 'delete';
          newChild.state = 'fail';
          newChild.selfLink = selfLink;
          newChild.error = e.message || e;
          this.log.error(newChild);
          await this.addChildren(newChild);
        }
      } else if (!exists) {
        this.log.info(`${methodName} ${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. leaving on cluster`);
        await this._patchChild(selfLink);
        let res = await this.patchSelf({
          status: {
            children: {
              [selfLink]: null
            }
          }
        }, { status: true });
        objectPath.set(this.data, 'object', res);
      }
    }));
    return res;

  }

  // Delete the child resource
  // Calling code does not check a return value
  async _deleteChild(childURI) {
    const methodName = `${moduleName}._deleteChild('${childURI}')`;
    this.log.info(`${methodName} entry`);

    let opt = { uri: childURI, simple: false, resolveWithFullResponse: true, method: 'DELETE' };
    let res = await this.kubeResourceMeta.request(opt);
    if (res.statusCode === 404 || res.statusCode === 200) {
      this.log.info(`${methodName} child deleted (RC: ${res.statusCode})`);
    }
    else {
      this.log.warn(`${methodName} child could not be deleted (RC: ${res.statusCode}): ${res.body}`);
      return Promise.reject({ statusCode: res.statusCode, body: res.body });
    }
  }

  // Patch the child resource to remove the `deploy.razee.io.parent` annotation
  // Calling code does not check a return value
  async _patchChild(childURI) {
    const methodName = `${moduleName}._patchChild('${childURI}')`;
    this.log.info(`${methodName} entry`);

    // Retrieve the child resource to get version/kind/namespace/name details
    const opt = { uri: childURI, simple: false, resolveWithFullResponse: true, method: 'GET' };
    const getChildResponse = await this.kubeResourceMeta.request(opt);
    if( getChildResponse.statusCode === 404 ) {
      this.log.info(`${methodName} child no longer exists (RC: ${getChildResponse.statusCode})`);
      return;
    }

    const childResource = yaml.loadAll(getChildResponse.body)[0];
    let childApiVersion = objectPath.get(childResource, 'apiVersion');
    let childKind = objectPath.get(childResource, 'kind');
    let childNamespace = objectPath.get(childResource, ['metadata', 'namespace']);
    let childName = objectPath.get(childResource, ['metadata', 'name']);

    // Get the Kube api krm for the child resource
    let krm = await this.kubeClass.getKubeResourceMeta(childApiVersion, childKind, 'update');
    if( !krm ) {
      this.log.warn(`${methodName} unable to get 'update' api for child. Child GET response (RC: ${getChildResponse.statusCode}): ${getChildResponse.body}`);
      return;
    }

    // Remove the parent ref from the child
    const patchObj = {
      metadata: {
        annotations: {
          'deploy.razee.io.parent': null
        }
      }
    };
    let patchRes = await krm.mergePatch(childName, childNamespace, patchObj, {simple: false, resolveWithFullResponse: true});

    if( patchRes.statusCode >= 200 && patchRes.statusCode < 300 ) {
      this.log.info(`${methodName} child patched (RC: ${patchRes.statusCode})`);
    }
    else {
      this.log.warn(`${methodName} child patch failure (RC: ${patchRes.statusCode}): ${patchRes.body}`);
    }
  }
};
