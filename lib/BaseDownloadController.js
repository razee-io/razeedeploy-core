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
const hash = require('object-hash');
const clone = require('clone');

const CompositeController = require('./CompositeController');


module.exports = class BaseDownloadController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.kapitan.razee.io';
    super(params);
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);
    // when failure to download optional resource occurs, should continue to download other requests, but shouldnt reconcile children
    let optionalResourceFailure = 0;
    let lastModifiedArray = objectPath.get(this.data, ['object', 'status', 'last-modified'], []);
    let newLastModifiedArray = [];

    for (var i = 0; i < requests.length; i++) {
      let request = requests[i];
      let requestHash = hash(request);

      let file;
      let fileCachePath = `./download-cache/${this.namespace}/${this.name}/${requestHash}`;
      let optional = request.optional || false;
      let reqOpt = clone(request.options);
      let url = objectPath.get(request, 'options.uri') || objectPath.get(request, 'options.url');

      let imsObj = lastModifiedArray.find((el) => objectPath.get(el, 'hash') == requestHash && objectPath.has(el, 'last-modified'));
      let fileCached = await fs.pathExists(fileCachePath);
      if (imsObj && fileCached) {
        objectPath.set(reqOpt, 'headers.If-Modified-Since', objectPath.get(imsObj, 'last-modified'));
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
            await fs.outputJson(fileCachePath, file);
            newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': resLM };
          }
        } else if (res.statusCode == 304) {
          this.log.debug(`Download ${res.statusCode} Not Modified ${url}`);
          if (fileCached) {
            file = await fs.readJson(fileCachePath);
            let resLM = objectPath.get(res, 'headers.last-modified');
            if (resLM) {
              newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': resLM };
            }
          } else {
            objectPath.del(request, 'options.headers.If-Modified-Since');
            // objectPath.del(request, 'options.headers.If-None-Match');
            this.log.debug(`Failed to find cached file, removing headers.If-Modified-Since to try again next time: ${res.statusCode} | ${url}`);
            ++optionalResourceFailure;
          }
        } else {
          this.log.debug(`Download failed: ${res.statusCode} | ${url}`);
          return Promise.reject({ statusCode: res.statusCode, uri: url });
        }

      } catch (e) {
        if (optional) {
          ++optionalResourceFailure;
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
        let msg = `Error applying file to kubernetes. StatusCode: ${e.statusCode} url: ${url} message: ${e.body.message}`;
        if (optional) {
          ++optionalResourceFailure;
          this.log.warn(msg);
          this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: `Error applying file to kubernetes, see logs for details. StatusCode: ${e.statusCode}`, url: url } });
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

    // update the last-modified array
    this.updateStatus({ path: ['last-modified'], status: newLastModifiedArray });

    if (optionalResourceFailure > 0) {
      let msg = `${optionalResourceFailure} optional resource(s) failed to process.. skipping reconcileChildren`;
      this.log.warn(msg);
      this.updateStatus({ path: ['warn', '-'], status: { controller: 'BaseDownload', warn: msg } });
    } else {
      await this.reconcileChildren();
    }

  }

  async _decomposeFile(file) {
    let kind = objectPath.get(file, ['kind'], '');
    let items = objectPath.get(file, ['items']);

    if (Array.isArray(file)) {
      let error;
      let res = await Promise.all(file.map(async f => {
        try {
          return await this._decomposeFile(f);
        } catch (e) {
          error = error || e;
        }
      }));
      return error ? Promise.reject(error) : res;
    } else if (kind.toLowerCase() == 'list' && Array.isArray(items)) {
      let error;
      let res = await Promise.all(items.map(async f => {
        try {
          return await this._decomposeFile(f);
        } catch (e) {
          error = error || e;
        }
      }));
      return error ? Promise.reject(error) : res;
    } else if (file) {
      return await this._saveChild(file);
    }
  }

  async _saveChild(child) {
    let res = await this.applyChild(child);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return Promise.reject(res);
    }
    return res;
  }

  async download() {
    // Input: request options
    // Output: http request full resonse with a 'body' element
    // Do not send back anything you dont want applied to kube
    throw Error('Override BaseDownloadController.download in the subclass.');
  }

};
