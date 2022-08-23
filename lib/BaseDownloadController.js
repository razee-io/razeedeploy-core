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
const { request } = require('@octokit/request');
const gh = require('parse-github-url');
const parsePath = require('parse-filepath');

const CompositeController = require('./CompositeController');

const FetchEnvs = require('./FetchEnvs');

module.exports = class BaseDownloadController extends CompositeController {
  constructor(params) {
    params.finalizerString = params.finalizerString || 'children.downloads.deploy.razee.io';
    super(params);
  }

  async added() {
    let requests = objectPath.get(this.data, ['object', 'spec', 'requests'], []);

    // when failure to download optional resource occurs, should continue to download other requests, but shouldnt reconcile children
    let optionalResourceFailure = 0;
    let lastModifiedArray = objectPath.get(this.data, ['object', 'status', 'last-modified'], []);
    let newLastModifiedArray = [];

    for (var i = 0; i < requests.length; i++) {
      let req = requests[i];
      let requestHash = hash(req);

      let file;
      let fileCachePath = `./download-cache/${this.namespace}/${this.name}/${requestHash}`;
      let optional = req.optional || false;
      let reqOpt = clone(req.options);

      let url;
      let foundurl = false;

      if (objectPath.has(req, 'options.headers.If-Modified-Since') || objectPath.has(req, 'options.headers.If-None-Match')) {
        this.log.warn('Should not include If-Modified-Since/If-None-Match in definition headers, removing from request..');
        objectPath.del(reqOpt, 'headers.If-Modified-Since');
        objectPath.del(reqOpt, 'headers.If-None-Match');
      }

      let imsObj = lastModifiedArray.find((el) => objectPath.get(el, 'hash') == requestHash && objectPath.has(el, 'last-modified'));
      let fileCached = await fs.pathExists(fileCachePath);
      this.log.debug(`Request Hash ${requestHash} ${imsObj ? 'found' : 'not found'} in .status.last-modified array and file ${fileCached ? 'is' : 'is not'} cached`);
      if (imsObj && fileCached) {
        this.log.debug(`Adding headers.If-Modified-Since to request from Request Hash ${requestHash}`);
        objectPath.set(reqOpt, 'headers.If-Modified-Since', objectPath.get(imsObj, 'last-modified'));
      }

      const git = objectPath.get(req, 'options.git');
      let github;
      let gitlab;
      let files;
      let glfile;
      let glfiles;
      let host;
      let project;
      let glpath;
      let glbranch;
      let bearer;
      let fileExt;
      let filename;
      if (git) {
        github = git.github;
        gitlab = git.gitlab;
        if (github) {
          const ghparse = gh(github.repo);
          const repo = ghparse.repo;
          let enterprise = '';
          if (ghparse.host == 'github.ibm.com') {
            enterprise = 'http://github.ibm.com/api/v3';
          }
          
          const branch = github.branch;
          
          const token = await this._getSecretData(github.token.name, github.token.key, github.token.ns);
          const pattern = parsePath(github.pattern);
          let path;
          if (pattern.ext == '') {
            path = pattern.path;
            fileExt = pattern.ext;
          } else {
            if (pattern.stem == '*') {
              fileExt = pattern.ext;
            } else {
              filename = pattern.base;
            }
            path = pattern.dir;
          }
  
          files = await request(`GET ${enterprise}/repos/${repo}/contents/${path}?ref=${branch}`, {
            headers: {
              authorization: 'token ' + token,
            }
          });
          
        } 
        else if (gitlab) {
          const glparse = gh(gitlab.project);
          project = glparse.path.replace('/', '%2F');
          host = glparse.host;
          const glpattern = parsePath(gitlab.pattern);
          
          if (glpattern.ext == '') {
            glpath = glpattern.path;
            fileExt = glpattern.ext;
          } else if (glpattern.stem == '*'){
            fileExt = glpattern.ext;
            glpath = glpattern.dir;
          } else {
            glpath = gitlab.pattern;
            filename = true;
          }
          glpath = glpath.replace('/', '%2F');

          glbranch = gitlab.branch;
          bearer = await this._getSecretData(gitlab.token.name, gitlab.token.key, gitlab.token.namespace);
          if (filename) {
            glfile = await request(`GET https://${host}/api/v4/projects/${project}/repository/files/${glpath}/raw?ref=${glbranch}`, {
              headers: {
                Authorization: 'Bearer ' + bearer
              }
            });
          } else {
            glfiles = await request(`GET https://${host}/api/v4/projects/${project}/repository/tree/?path=${glpath}&ref=${glbranch}`, {
              headers: {
                Authorization: 'Bearer ' + bearer
              }
            });
          }
        }
      } else {
        url = objectPath.get(req, 'options.uri') || objectPath.get(req, 'options.url');
        foundurl = true;
      }

      try {
        reqOpt = await this._fetchHeaderSecrets(reqOpt);
      } catch (e) {
        // error fetching header secrets
        if (optional) {
          ++optionalResourceFailure;
          this.log.warn(e.message);
          this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: e.message, url: url });
          this.log.debug(`skipping download for ${url}`);
          continue; // shouldnt continue to try to download if unable to get secret headers
        } else {
          return Promise.reject(e.message);
        }
      }
      
      let j = 0;
      let numFiles;
      if (github) {
        numFiles = files.data.length;
      } else if (glfiles) {
        numFiles = glfiles.data.length;
      } else {
        numFiles = 1;
      }

      while (j < numFiles) {
        if (files) {
          if (parsePath(files.data[j].name).ext == fileExt || files.data[j].name == filename || fileExt == '') {
            if (files.data[j].download_url) {
              reqOpt = { ...reqOpt, url: files.data[j].download_url };
              url = files.data[j].download_url;
              foundurl = true;
            } else {
              foundurl = false;
            }
          } else {
            foundurl = false;
          }
        } else if (glfiles) {
          if (parsePath(glfiles.data[j].name).ext == fileExt || fileExt == '') {
            let reqglpath = '';
            if (glpath != '') {
              reqglpath = glpath + '%2F';
            }
            glfile = await request(`GET https://${host}/api/v4/projects/${project}/repository/files/${reqglpath}${glfiles.data[j].name}/raw?ref=${glbranch}`, {
              headers: {
                Authorization: 'Bearer ' + bearer
              }
            });
          }
        }

        if (foundurl || glfile) {
          try {
            let res;
            if (!gitlab) {
              res = await this.download(reqOpt);
              if (res.toJSON instanceof Function) {
                res = res.toJSON();
              }
            } else {
              res = glfile;
              url = 'gitlab';
            }
            if ((res.statusCode >= 200 && res.statusCode < 300) || (res.status >= 200 && res.status < 300)) {
              this.log.debug(`Download ${res.statusCode || res.status} ${url}`);
              file = glfile ? yaml.loadAll(glfile.data) : yaml.loadAll(res.body);
              if (Array.isArray(file) && file.length == 1) { file = file[0]; }            
              // TODO if last-modified doesnt exist try etag
              // use with request at .headers.If-None-Match
              let resLM = objectPath.get(res, 'headers.last-modified');
              if (resLM) {
                await fs.outputJson(fileCachePath, file);
                newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': resLM };
              }
            } else if ((res.statusCode == 304 || res.status == 304) && fileCached) {
              this.log.debug(`Download ${res.statusCode || res.status} Not Modified ${url}`);
              file = await fs.readJson(fileCachePath);
              newLastModifiedArray[i] = { hash: requestHash, url: url, 'last-modified': objectPath.get(imsObj, 'last-modified') };
            } else {
              this.log.debug(`Download failed: ${res.statusCode || res.status} | ${url}`);
              throw { statusCode: res.statusCode || res.status, uri: url };
            }
          } catch (e) {
            if (optional) {
              ++optionalResourceFailure;
              this.log.warn(e.message || e);
              this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: `Error downloading file. StatusCode: ${e.statusCode}`, url: url });
              file = [];
              newLastModifiedArray[i] = { hash: requestHash, url: url };
            } else {
              if (e.message === undefined) this.log.error(e);
              return Promise.reject(`uri: ${reqOpt.uri || reqOpt.url}, statusCode: ${e.statusCode}, message: ${e.message}`);
            }
          }
    
          try {
            await this._decomposeFile(file);
          } catch (e) {
            let msg = `Error applying file to kubernetes. StatusCode: ${e.statusCode} url: ${url} message: ${objectPath.get(e, 'body.message', e)}`;
            if (optional) {
              ++optionalResourceFailure;
              this.log.warn(msg);
              this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: `Error applying file to kubernetes, see logs for details. StatusCode: ${e.statusCode}`, url: url });
            } else {
              return Promise.reject(msg);
            }
          }
        }
        j++;
      }
    }

    // update the last-modified array
    let res = await this.patchSelf({
      status: {
        'last-modified': newLastModifiedArray
      }
    }, { status: true });
    objectPath.set(this.data, 'object', res); // save latest patch response

    if (optionalResourceFailure > 0) {
      let msg = `${optionalResourceFailure} optional resource(s) failed to process.. skipping reconcileChildren`;
      this.log.warn(msg);
      this.updateRazeeLogs('warn', { controller: 'BaseDownload', warn: msg });
    } else {
      await this.reconcileChildren();
    }

  }

  // Helpers ==================================
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

  async _fetchHeaderSecrets(requestOptions) {
    requestOptions = clone(requestOptions);
    let headers = objectPath.get(requestOptions, 'headers');
    if (headers) {
      for (let [hKey, hObject] of Object.entries(headers)) {
        let secretRef = objectPath.get(hObject, 'valueFrom.secretKeyRef');
        if (secretRef) {
          let secretName = objectPath.get(secretRef, 'name');
          let secretNamespace = objectPath.get(secretRef, 'namespace', this.namespace);
          let secretKey = objectPath.get(secretRef, 'key');
          try {
            objectPath.set(headers, [hKey], await this._getSecretData(secretName, secretKey, secretNamespace));
          } catch (e) {
            throw Error(`Unable to fetch header secret data. { name: ${secretName}, namespace: ${secretNamespace}, key: ${secretKey} }: ${objectPath.get(e, 'error.message')}`);
          }
        }
      }
    }

    const reqopt = new FetchEnvs(this);
    const headersFrom = objectPath.get(requestOptions, 'headersFrom');
    if (headersFrom) {
      const headersFromTemp = await reqopt.processEnvFrom(headersFrom);
      let mergedHeaders = { ...headers };
      for (const header of headersFromTemp) {
        const data = header?.data;
        mergedHeaders = { ...mergedHeaders, ...data };
      }
      requestOptions = { ...requestOptions, headers: mergedHeaders };
    }

    return requestOptions;
  }

  async _getSecretData(name, key, ns) {
    ns = ns || this.namespace;
    let res = await this.kubeResourceMeta.request({ uri: `/api/v1/namespaces/${ns}/secrets/${name}`, json: true });
    let secret = Buffer.from(objectPath.get(res, ['data', key], ''), 'base64').toString();
    if (secret === '') {
      throw {
        name: 'StatusCodeError',
        statusCode: 404,
        message: `404 - key "${key}" not found in secret "${name}", in namespace "${ns}"`,
        error: {
          kind: 'Status',
          apiVersion: 'v1',
          metadata: {},
          status: 'Failure',
          message: `key "${key}" not found in secret "${name}", in namespace "${ns}"`,
          reason: 'NotFound',
          details: { 'name': name, 'namespace': ns, 'kind': 'secrets', 'key': key },
          code: 404
        }
      };
    }
    return secret;
  }

  async _saveChild(child) {
    let res = await this.applyChild(child);
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
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
