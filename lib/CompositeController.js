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

const BaseController = require('./BaseController');


module.exports = class CompositeController extends BaseController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.compositecontroller.deploy.razee.io';
    super(params);
  }

  async finalizerCleanup() {
    // if cleanup fails, do not return successful response => Promise.reject(err) or throw Error(err)
    let children = objectPath.get(this.data, ['object', 'status', 'children'], {});
    let res = await Promise.all(Object.entries(children).map(async ([selfLink, child]) => {
      let reconcile = objectPath.get(child, ['deploy.razee.io/Reconcile']) ||
        objectPath.get(child, ['kapitan.razee.io/Reconcile'], this.reconcileDefault);
      if (reconcile.toLowerCase() == 'true') {
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
          return Promise.reject({ selfLink: selfLink, action: 'delete', state: 'fail', error: e.message || e });
        }
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
    if (child.apiVersion.toLowerCase() == 'v1' && child.kind.toLowerCase() == 'list' && Array.isArray(child.items)) {
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

    let krm = await this.kubeClass.getKubeResourceMeta(child.apiVersion, child.kind, 'update');
    if (!krm) {
      let ns = objectPath.get(child, 'metadata.namespace');
      let childUri = `${child.apiVersion}/${child.kind}/${ns ? `namespace/${ns}/` : ''}${objectPath.get(child, 'metadata.name')}`;
      return { statusCode: 404, body: { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: `Unable to find kubernetes resource matching: ${child.apiVersion}/${child.kind}`, reason: 'NotFound', details: { apiVersion: `${child.apiVersion}`, kind: `${child.kind}`, uri: childUri }, code: 404 } };
    }

    let res;
    let reconcile = objectPath.get(child, ['metadata', 'labels', 'deploy.razee.io/Reconcile']) ||
      objectPath.get(child, ['metadata', 'labels', 'kapitan.razee.io/Reconcile'], this.reconcileDefault);
    let mode = objectPath.get(child, ['metadata', 'labels', 'deploy.razee.io/mode']) ||
      objectPath.get(child, ['metadata', 'labels', 'kapitan.razee.io/mode'], 'Apply');
    if (!objectPath.has(child, ['metadata', 'namespace']) && krm.namespaced) {
      objectPath.set(child, ['metadata', 'namespace'], this.namespace);
    }
    let childUri = krm.uri({ name: child.metadata.name, namespace: child.metadata.namespace });
    let childUid = objectPath.get(res, 'body.metadata.uid');

    try {
      switch (mode.toLowerCase()) {
        case 'StrategicMergePatch'.toLowerCase():
          res = await this.apply(krm, child, { mode: 'StrategicMergePatch' });
          break;
        case 'EnsureExists'.toLowerCase():
          res = await this.ensureExists(krm, child);
          break;
        default:
          res = await this.apply(krm, child);
      }
      await this.addChildren({ uid: childUid, selfLink: childUri, 'deploy.razee.io/Reconcile': reconcile });
      this.log.info(`${mode} ${res.statusCode} ${childUri}`);
    } catch (e) {
      res = e;
    }
    return res;
  }

  async reconcileChildren() {
    let newChildren = this.children; // children that were computed this cycle
    let oldChildren = objectPath.get(this.data, ['object', 'status', 'children'], {}); // children that existed at the start of the cycle

    if (Object.entries(newChildren).length < Object.entries(oldChildren).length) {
      this.log.info(`Less children found this cycle then previously (${Object.entries(newChildren).length} < ${Object.entries(oldChildren).length}).. ReconcileChildren called by ${objectPath.get(this.data, ['object', 'metadata', 'selfLink'])}`);
    }

    let res = await Promise.all(Object.entries(oldChildren).map(async ([selfLink, child]) => {
      const newChild = clone(child);
      let reconcile = objectPath.get(child, ['deploy.razee.io/Reconcile']) ||
        objectPath.get(child, ['kapitan.razee.io/Reconcile'], this.reconcileDefault);
      let exists = objectPath.has(newChildren, [selfLink]);
      if (!exists && reconcile.toLowerCase() == 'true') {
        this.log.info(`${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. removing from cluster`);
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
        this.log.info(`${selfLink} no longer applied.. Reconcile ${reconcile.toLowerCase()}.. leaving on cluster`);
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

  async _deleteChild(child) {
    this.log.info(`Delete ${child}`);
    let opt = { uri: child, simple: false, resolveWithFullResponse: true, method: 'DELETE' };

    let res = await this.kubeResourceMeta.request(opt);
    if (res.statusCode === 404) {
      this.log.debug(`Delete ${res.statusCode} ${opt.uri || opt.url}`);
      return { statusCode: res.statusCode, body: res.body };
    } else if (res.statusCode !== 200) {
      this.log.debug(`Delete ${res.statusCode} ${opt.uri || opt.url}`);
      return Promise.reject({ statusCode: res.statusCode, body: res.body });
    }
    this.log.debug(`Delete ${res.statusCode} ${opt.uri || opt.url}`);
    return { statusCode: res.statusCode, body: res.body };
  }


};
