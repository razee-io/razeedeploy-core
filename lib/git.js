const gh = require('parse-github-url');
const parsePath = require('parse-filepath');

module.exports = {
  'createGit': function(reqOpt) {
    var git = {};
    const gitinfo = reqOpt.git;

    const parse = gh(gitinfo.repo);
    git.host = parse.host;
    git.repo = parse.repo;
    git.branch = gitinfo.branch;
    const pattern = parsePath(gitinfo.filePath);
    if (pattern.ext == '') {
      if (gitinfo.filePath.endsWith('*')) {
        git.path = pattern.dir;
      } else {
        git.path = pattern.path;
      }
      git.fileExt = pattern.ext;
    } else {
      if (pattern.stem == '*') {
        git.fileExt = pattern.ext;
      } else {
        git.filename = pattern.base;
      }
      git.path = pattern.dir;
    }

    if (gitinfo.provider == 'github') {
      let enterprise = '';
      if (git.host != 'github.com') {
        enterprise = `http://${git.host}/api/v3`;
      }
      if (git.path.endsWith('/')) {
        git.path = git.path.slice(0, -1);
      }
      git.requrl = `GET ${enterprise}/repos/${git.repo}/contents/${git.path}?ref=${git.branch}`;
      if (reqOpt.headers.Authorization && !reqOpt.headers.Authorization.includes('token')) {
        reqOpt.headers = { ...reqOpt.headers, Authorization: 'token ' + reqOpt.headers.Authorization };
      }
      
    } 
    else if (gitinfo.provider == 'gitlab') {
      git.repo = encodeURIComponent(git.repo);
      git.path = encodeURIComponent(git.path);
      git.requrl = `GET https://${git.host}/api/v4/projects/${git.repo}/repository/tree/?path=${git.path}&ref=${git.branch}`;
      if (reqOpt.headers.Authorization && !reqOpt.headers.Authorization.includes('Bearer')) {
        reqOpt.headers = { ...reqOpt.headers, Authorization: 'Bearer ' + reqOpt.headers.Authorization };
      }
    }

    git.getUrl = function(file) {
      let url;
      if (parsePath(file.name).ext == git.fileExt || file.name == git.filename || git.fileExt == '') {
        if (gitinfo.provider == 'github') {
          if (file.download_url) {
            url = file.download_url;
          }
        } else if (gitinfo.provider == 'gitlab') {
          let reqglpath = git.path;
          if (git.path != '' && !git.path.endsWith('%2F')) {
            reqglpath = git.path + '%2F';
          }
          url = `https://${git.host}/api/v4/projects/${git.repo}/repository/files/${reqglpath}${file.name}/raw?ref=${git.branch}`;
        } 
      }
      
      return url;
    };
    
    
    return git;
  }
};
