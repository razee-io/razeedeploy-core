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
const fs = require('fs-extra');

const CompositeController = require('./CompositeController');


module.exports = class BaseDownloadController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.kapitan.razee.io';
    super(params);
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);

    for (var i = 0; i < requests.length; i++) {
      let request = requests[i];

      let file;
      let optional = request.optional || false;
      let reqOpt = request.options;
      let url = objectPath.get(request, 'options.uri') || objectPath.get(request, 'options.url');

      let optIMS = objectPath.has(request, 'options.headers.If-Modified-Since');
      let fileCached = await fs.pathExists(`./download-cache/${this.namespace}/${this.name}/${url}`);
      if (optIMS && !fileCached) {
        objectPath.del(request, 'options.headers.If-Modified-Since');
      }

      try {
        let res = await this.download(reqOpt);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.log.debug(`Download ${res.statusCode} ${url}`);
          file = yaml.safeLoadAll(res.body);
          if (Array.isArray(file) && file.length == 1) { file = file[0]; }

          // TODO if last-modified doesnt exist try etag
          // use with request at .headers.If-None-Match
          let resLM = objectPath.get(res, 'headers.last-modified');
          if (resLM) {
            await fs.outputJson(`./download-cache/${this.namespace}/${this.name}/${url}`, file);
            objectPath.set(request, 'options.headers.If-Modified-Since', resLM);
          }
        } else if (res.statusCode == 304) {
          this.log.debug(`Download ${res.statusCode} Not Modified ${url}`);
          file = await fs.readJson(`./download-cache/${this.namespace}/${this.name}/${url}`);
        } else {
          this.log.debug(`Download ${res.statusCode} ${url}`);
          return Promise.reject({ statusCode: res.statusCode, uri: url });
        }

      } catch (e) {
        if (optional) {
          this.log.warn(e.message || e);
          this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: `uri: ${url}, statusCode: ${e.statusCode}` } });
          file = [];
        } else {
          return Promise.reject(`uri: ${reqOpt.uri || reqOpt.url}, statusCode: ${e.statusCode}`);
        }
      }

      try {
        await this._decomposeFile(file);
      } catch (e) {
        let msg = `${url} ${JSON.stringify(e.message || e)}`;
        if (optional) {
          this.log.warn(msg);
          this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: msg } });
        } else {
          return Promise.reject(msg);
        }
      }

    }

    if (objectPath.has(this.data, ['object', 'spec', 'requests'])) {
      let patchObject = { spec: { requests: objectPath.get(this.data, ['object', 'spec', 'requests']) } };
      let cont = await this.patchSelf(patchObject);
      if (!cont) return;
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

};
