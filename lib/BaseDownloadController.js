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
const yaml = require('js-yaml');

const CompositeController = require('./CompositeController');


module.exports = class BaseDownloadController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.kapitan.razee.io';
    super(params);
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);
    let downloadedFiles = await this.asyncMapSettle(requests, async (request) => {
      let file;
      let optional = request.optional || false;
      let reqOpt = request.options || request;
      try {
        let res = await this.download(reqOpt);
        let data = res.body;
        file = yaml.safeLoadAll(data);
        if (Array.isArray(file) && file.length == 1) {
          file = file[0];
        }
      } catch (e) {
        if (optional) {
          this.log.warn(e.message || e);
          this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: `uri: ${reqOpt.uri || reqOpt.url}, statusCode: ${e.statusCode}` } });
          file = [];
        } else {
          return Promise.reject(`uri: ${reqOpt.uri || reqOpt.url}, statusCode: ${e.statusCode}`);
        }
      }
      return { file: file, optional: optional, uri: reqOpt.uri || reqOpt.url };
    });

    for (var i = 0; i < downloadedFiles.length; i++) {
      try {
        await this._decomposeFile(downloadedFiles[i].file);
      } catch (e) {
        let msg = `${downloadedFiles[i].uri} ${JSON.stringify(e.message || e)}`;
        if (downloadedFiles[i].optional) {
          this.log.warn(msg);
          this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: msg } });
        } else {
          return Promise.reject(msg);
        }
      }
    }

    await this.reconcileChildren();
  }

  async _decomposeFile(file) {
    let kind = objectPath.get(file, ['kind'], '');
    let items = objectPath.get(file, ['items']);

    if (Array.isArray(file)) {
      return await Promise.all(file.map(async f => {
        await this._decomposeFile(f);
      }));
    } else if (kind.toLowerCase() == 'list' && Array.isArray(items)) {
      return await Promise.all(items.map(async f => {
        await this._decomposeFile(f);
      }));
    } else if (file) {
      return await this._saveChild(file);
    }
  }

  async _saveChild(child) {
    let res = await this.applyChild(child);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return Promise.reject(res);
    }
  }

  async download() {
    // Input: request options
    // Output: http request full resonse with a 'body' element
    // Do not send back anything you dont want applied to kube
    throw Error('Override BaseDownloadController.download in the subclass.');
  }

  async asyncMapSettle(array, callback) {
    let res = await Promise.all(array.map(async (el, index) => {
      try {
        let val = await callback(el, index, array);
        return { resolved: val };
      } catch (e) {
        return { rejected: e };
      }
    }));
    for (var i = 0; i < res.length; i++) {
      if (objectPath.has(res[i], 'rejected')) {
        return Promise.reject(objectPath.get(res[i], 'rejected'));
      } else {
        res[i] = objectPath.get(res, [i, 'resolved']);
      }
    }
    return res;
  }

};
