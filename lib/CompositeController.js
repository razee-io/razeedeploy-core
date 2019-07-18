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

const BaseController = require('./BaseController');


module.exports = class CompositeController extends BaseController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.compositecontroller.kapitan.razee.io';
    super(params);
  }

  async finalizerCleanup() {
    // if cleanup fails, do not return successful response => Promise.reject(err) or throw Error(err)
    let children = objectPath.get(this.data, ['object', 'status', 'children'], {});
    let res = await Promise.all(Object.entries(children).map(async ([selfLink, child]) => {
      let reconcile = objectPath.get(child, ['kapitan.razee.io/Reconcile'], 'true');
      if (reconcile.toLowerCase() == 'true') {
        try {
          await this._deleteChild(selfLink);
          this.updateStatus({ path: ['children', selfLink], status: null });
        } catch (e) {
          return Promise.reject({ selfLink: selfLink, action: 'delete', state: 'fail', error: e.message || e });
        }
      }
    }));
    return res;
  }

  addChildren(children) {
    if (Array.isArray(children)) {
      children.map(child => {
        let selfLink = child.selfLink;
        objectPath.del(child, 'selfLink');
        this.updateStatus({ path: ['children', selfLink], status: child });
      });
    } else {
      let selfLink = children.selfLink;
      objectPath.del(children, 'selfLink');
      this.updateStatus({ path: ['children', selfLink], status: children });
    }
  }

  async applyChild(child) {
    if (child.apiVersion.toLowerCase() == 'v1' && child.kind.toLowerCase() == 'list' && Array.isArray(child.items)) {
      try {
        let res = await Promise.all(child.items.map(async item => { return await this.applyChild(item); }));
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
    let reconcile = objectPath.get(child, ['metadata', 'labels', 'kapitan.razee.io/Reconcile'], this.reconcileDefault);
    let mode = objectPath.get(child, ['metadata', 'labels', 'kapitan.razee.io/mode'], 'Apply');
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
      this.addChildren({ uid: childUid, selfLink: childUri, 'kapitan.razee.io/Reconcile': reconcile });
      this.log.info(`${mode} ${res.statusCode} ${childUri}`);
    } catch (e) {
      res = e;
    }
    return res;
  }

  async reconcileChildren() {
    let newChildren = objectPath.get(this.status, ['children'], {}); // children that were computed this cycle
    let oldChildren = objectPath.get(this.data, ['object', 'status', 'children'], {}); // children that existed at the start of the cycle

    let res = await Promise.all(Object.entries(oldChildren).map(async ([selfLink, child]) => {
      let reconcile = objectPath.get(child, ['kapitan.razee.io/Reconcile'], 'true');
      let exists = objectPath.get(newChildren, [selfLink], false);
      if (!exists && reconcile.toLowerCase() == 'true') {
        try {
          await this._deleteChild(selfLink);
          this.updateStatus({ path: ['children', selfLink], status: null });
        } catch (e) {
          // if fail to delete, keep as a child until next cycle to retry
          child.action = 'delete';
          child.state = 'fail';
          child.selfLink = selfLink;
          child.error = e.message || e;
          this.log.error(child);
          this.addChildren(child);
        }
      } else if (!exists) {
        this.updateStatus({ path: ['children', selfLink], status: null });
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
