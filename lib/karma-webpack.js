'use strict';

var _ = require('lodash');
var path = require('path');
var async = require('async');
var webpackDevMiddleware = require('webpack-dev-middleware');
var webpack = require('webpack');
var SingleEntryDependency = require('webpack/lib/dependencies/SingleEntryDependency');

var blocked = [];
var isBlocked = false;

function Plugin(
/* config.webpack */webpackOptions,
/* config.webpackServer */webpackServerOptions,
/* config.webpackMiddleware */webpackMiddlewareOptions,
/* config.basePath */basePath,
/* config.files */files,
/* config.frameworks */frameworks, customFileHandlers, emitter) {
  webpackOptions = _.clone(webpackOptions) || {};
  webpackMiddlewareOptions = _.clone(webpackMiddlewareOptions || webpackServerOptions) || {};

  var applyOptions = Array.isArray(webpackOptions) ? webpackOptions : [webpackOptions];
  var includeIndex = applyOptions.length > 1;

  applyOptions.forEach(function (webpackOptions, index) {
    // The webpack tier owns the watch behavior so we want to force it in the config
    webpackOptions.watch = true;

    // Webpack 2.1.0-beta.7+ will throw in error if both entry and plugins are not specified in options
    // https://github.com/webpack/webpack/commit/b3bc5427969e15fd3663d9a1c57dbd1eb2c94805
    if (!webpackOptions.entry) {
      webpackOptions.entry = function () {
        return {};
      };
    };

    if (!webpackOptions.output) {
      webpackOptions.output = {};
    };

    // When using an array, even of length 1, we want to include the index value for the build.
    // This is due to the way that the dev server exposes commonPath for build output.
    var indexPath = includeIndex ? index + '/' : '';
    var publicPath = indexPath !== '' ? indexPath + '/' : '';

    // Must have the common _karma_webpack_ prefix on path here to avoid
    // https://github.com/webpack/webpack/issues/645
    webpackOptions.output.path = '/_karma_webpack_/' + indexPath;
    webpackOptions.output.publicPath = '/_karma_webpack_/' + publicPath;
    webpackOptions.output.filename = '[name]';
    if (includeIndex) {
      webpackOptions.output.jsonpFunction = 'webpackJsonp' + index;
    }
    webpackOptions.output.chunkFilename = '[id].bundle.js';
  });

  this.emitter = emitter;
  this.wrapMocha = frameworks.indexOf('mocha') >= 0 && includeIndex;
  this.optionsCount = applyOptions.length;
  this.files = [];
  this.failedFiles = [];
	this.hotFiles = [];
  this.basePath = basePath;
  this.waiting = [];

  var compiler;
  try {
    compiler = webpack(webpackOptions);
  } catch (e) {
    console.error(e.stack || e);
    if (e.details) {
      console.error(e.details);
    }
    throw e;
  }

  var applyPlugins = compiler.compilers || [compiler];

  applyPlugins.forEach(function (compiler) {
    compiler.plugin('this-compilation', function (compilation, params) {
      compilation.dependencyFactories.set(SingleEntryDependency, params.normalModuleFactory);
    });
    compiler.plugin('make', this.make.bind(this));
  }, this);

  ['invalid', 'watch-run', 'run'].forEach(function (name) {
    compiler.plugin(name, function (_, callback) {
      isBlocked = true;

      if (typeof callback === 'function') {
        callback();
      }
    });
  });

  compiler.plugin('done', function (stats) {
	  function isBuilt(module) { return module.rawRequest && module.built; }
		function getId(module) { return module.rawRequest; }
		function setTrue(acc, key) { acc[key] = true; return acc; }

		var affectedFiles = stats.compilation.modules
		                         .filter(isBuilt)
			                       .map(getId)
			                       .reduce(setTrue, {})
		var seen = {};

		function findAffected(module) {
			if (seen[module.rawRequest]) return;
			seen[module.rawRequest] = true;

			if (affectedFiles[module.rawRequest]) return;
			if (!module.dependencies) return;
			if (!module.rawRequest) return;

			module.dependencies.forEach(function (dependency) {
				if (!dependency.module) return;

				findAffected(dependency.module);
				if (affectedFiles[dependency.module.rawRequest]) {
					affectedFiles[module.rawRequest] = true;
				}
			});
		}
		stats.compilation.modules.forEach(findAffected);
		this.hotFiles = Object.keys(affectedFiles);

    var applyStats = Array.isArray(stats.stats) ? stats.stats : [stats];
    var assets = [];
    var noAssets = false;

    applyStats.forEach(function (stats) {
      stats = stats.toJson();

      assets.push.apply(assets, stats.assets);
      if (stats.assets.length === 0) {
        noAssets = true;
      }
    });

    if (!this.waiting || this.waiting.length === 0) {
      this.notifyKarmaAboutChanges();
    }

    if (this.waiting && !noAssets) {
      var w = this.waiting;

      this.waiting = null;
      w.forEach(function (cb) {
        cb();
      });
    }

    isBlocked = false;
    for (var i = 0; i < blocked.length; i++) {
      blocked[i]();
    }
    blocked = [];
  }.bind(this));
  compiler.plugin('invalid', function () {
    if (!this.waiting) {
      this.waiting = [];
    }
  }.bind(this));

  webpackMiddlewareOptions.publicPath = '/_karma_webpack_/';
  var middleware = this.middleware = new webpackDevMiddleware(compiler, webpackMiddlewareOptions);

  customFileHandlers.push({
    urlRegex: /^\/_karma_webpack_\/.*/,
    handler: function handler(req, res) {
      middleware(req, res, function () {
        res.statusCode = 404;
        res.end('Not found');
      });
    }
  });

	emitter.on('run_complete', function(args) {
		if (args.getResults().failed) {
			[].push.apply(this.failedFiles, this.hotFiles);
		} else {
			this.failedFiles = [];
		}
	}.bind(this));

  emitter.on('exit', function (done) {
    middleware.close();
    done();
  });
}

Plugin.prototype.notifyKarmaAboutChanges = function () {
  // Force a rebuild
  this.emitter.refreshFiles();
};

Plugin.prototype.addFile = function (entry) {
  if (this.files.indexOf(entry) >= 0) {
    return;
  }
  this.files.push(entry);

  return true;
};

Plugin.prototype.make = function (compilation, callback) {
  async.forEach(this.files.slice(), function (file, callback) {
    var entry = file;

    if (this.wrapMocha) {
      entry = require.resolve('./mocha-env-loader') + '!' + entry;
    }

    var dep = new SingleEntryDependency(entry);

    compilation.addEntry('', dep, path.relative(this.basePath, file).replace(/\\/g, '/'), function () {
      // If the module fails because of an File not found error, remove the test file
      if (dep.module && dep.module.error && dep.module.error.error && dep.module.error.error.code === 'ENOENT') {
        this.files = this.files.filter(function (f) {
          return file !== f;
        });
        this.middleware.invalidate();
      }
      callback();
    }.bind(this));
  }.bind(this), callback);
};

Plugin.prototype.readFile = function (file, callback) {
  var middleware = this.middleware;
  var optionsCount = this.optionsCount;

  var doRead = function () {
    if (optionsCount > 1) {
      async.times(optionsCount, function (idx, callback) {
        middleware.fileSystem.readFile('/_karma_webpack_/' + idx + '/' + file.replace(/\\/g, '/'), callback);
      }, function (err, contents) {
        if (err) {
          return callback(err);
        };
        contents = contents.reduce(function (arr, x) {
          if (!arr) {
            return [x];
          };
          arr.push(new Buffer('\n'), x);

          return arr;
        }, null);
        callback(null, Buffer.concat(contents));
      });
    } else {
      try {
        var fileContents = middleware.fileSystem.readFileSync('/_karma_webpack_/' + file.replace(/\\/g, '/'));

        callback(undefined, fileContents);
      } catch (e) {
        // If this is an error from `readFileSync` method, wait for the next tick.
        // Credit #69 @mewdriller
        if (e.code === 'ENOENT') {
          // eslint-disable-line quotes
          this.waiting = [process.nextTick.bind(process, this.readFile.bind(this, file, callback))];

          // throw otherwise
        } else {
          callback(e);
        }
      }
    }
  }.bind(this);

  if (!this.waiting) {
    doRead();
  } else {
    // Retry to read once a build is finished
    // do it on process.nextTick to catch changes while building
    this.waiting.push(process.nextTick.bind(process, this.readFile.bind(this, file, callback)));
  }
};

function createPreprocesor( /* config.basePath */basePath, webpackPlugin) {
  return function (content, file, done) {
    if (webpackPlugin.addFile(file.path)) {
      // recompile as we have an asset that we have not seen before
      webpackPlugin.middleware.invalidate();
    }

    // read blocks until bundle is done
    webpackPlugin.readFile(path.relative(basePath, file.path), function (err, content) {
      if (err) {
        throw err;
      }

			function addManifest(content) {
				var hotFiles = JSON.stringify(webpackPlugin.hotFiles.concat(webpackPlugin.failedFiles));
			  return content.replace(/__karmaWebpackManifest__\s*=\s*\[\s*\]/gm, "__karmaWebpackManifest__=" + hotFiles)
			}

      done(err, content && addManifest(content.toString()));
    });
  };
}

function createWebpackBlocker() {
  return function (request, response, next) {
    if (isBlocked) {
      blocked.push(next);
    } else {
      next();
    }
  };
}

module.exports = {
  webpackPlugin: ['type', Plugin],
  'preprocessor:webpack': ['factory', createPreprocesor],
  'middleware:webpackBlocker': ['factory', createWebpackBlocker]
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImthcm1hLXdlYnBhY2suanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJwYXRoIiwiYXN5bmMiLCJ3ZWJwYWNrRGV2TWlkZGxld2FyZSIsIndlYnBhY2siLCJTaW5nbGVFbnRyeURlcGVuZGVuY3kiLCJibG9ja2VkIiwiaXNCbG9ja2VkIiwiUGx1Z2luIiwid2VicGFja09wdGlvbnMiLCJ3ZWJwYWNrU2VydmVyT3B0aW9ucyIsIndlYnBhY2tNaWRkbGV3YXJlT3B0aW9ucyIsImJhc2VQYXRoIiwiZmlsZXMiLCJmcmFtZXdvcmtzIiwiY3VzdG9tRmlsZUhhbmRsZXJzIiwiZW1pdHRlciIsImNsb25lIiwiYXBwbHlPcHRpb25zIiwiQXJyYXkiLCJpc0FycmF5IiwiaW5jbHVkZUluZGV4IiwibGVuZ3RoIiwiZm9yRWFjaCIsImluZGV4Iiwid2F0Y2giLCJlbnRyeSIsIm91dHB1dCIsImluZGV4UGF0aCIsInB1YmxpY1BhdGgiLCJmaWxlbmFtZSIsImpzb25wRnVuY3Rpb24iLCJjaHVua0ZpbGVuYW1lIiwid3JhcE1vY2hhIiwiaW5kZXhPZiIsIm9wdGlvbnNDb3VudCIsIndhaXRpbmciLCJjb21waWxlciIsImUiLCJjb25zb2xlIiwiZXJyb3IiLCJzdGFjayIsImRldGFpbHMiLCJhcHBseVBsdWdpbnMiLCJjb21waWxlcnMiLCJwbHVnaW4iLCJjb21waWxhdGlvbiIsInBhcmFtcyIsImRlcGVuZGVuY3lGYWN0b3JpZXMiLCJzZXQiLCJub3JtYWxNb2R1bGVGYWN0b3J5IiwibWFrZSIsImJpbmQiLCJuYW1lIiwiY2FsbGJhY2siLCJzdGF0cyIsImFwcGx5U3RhdHMiLCJhc3NldHMiLCJub0Fzc2V0cyIsInRvSnNvbiIsInB1c2giLCJhcHBseSIsIm5vdGlmeUthcm1hQWJvdXRDaGFuZ2VzIiwidyIsImNiIiwiaSIsIm1pZGRsZXdhcmUiLCJ1cmxSZWdleCIsImhhbmRsZXIiLCJyZXEiLCJyZXMiLCJzdGF0dXNDb2RlIiwiZW5kIiwib24iLCJkb25lIiwiY2xvc2UiLCJwcm90b3R5cGUiLCJyZWZyZXNoRmlsZXMiLCJhZGRGaWxlIiwic2xpY2UiLCJmaWxlIiwicmVzb2x2ZSIsImRlcCIsImFkZEVudHJ5IiwicmVsYXRpdmUiLCJyZXBsYWNlIiwibW9kdWxlIiwiY29kZSIsImZpbHRlciIsImYiLCJpbnZhbGlkYXRlIiwicmVhZEZpbGUiLCJkb1JlYWQiLCJ0aW1lcyIsImlkeCIsImZpbGVTeXN0ZW0iLCJlcnIiLCJjb250ZW50cyIsInJlZHVjZSIsImFyciIsIngiLCJCdWZmZXIiLCJjb25jYXQiLCJmaWxlQ29udGVudHMiLCJyZWFkRmlsZVN5bmMiLCJ1bmRlZmluZWQiLCJwcm9jZXNzIiwibmV4dFRpY2siLCJjcmVhdGVQcmVwcm9jZXNvciIsIndlYnBhY2tQbHVnaW4iLCJjb250ZW50IiwidG9TdHJpbmciLCJjcmVhdGVXZWJwYWNrQmxvY2tlciIsInJlcXVlc3QiLCJyZXNwb25zZSIsIm5leHQiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQUlBLElBQUlDLFFBQVEsUUFBUixDQUFSO0FBQ0EsSUFBSUMsT0FBT0QsUUFBUSxNQUFSLENBQVg7QUFDQSxJQUFJRSxRQUFRRixRQUFRLE9BQVIsQ0FBWjtBQUNBLElBQUlHLHVCQUF1QkgsUUFBUSx3QkFBUixDQUEzQjtBQUNBLElBQUlJLFVBQVVKLFFBQVEsU0FBUixDQUFkO0FBQ0EsSUFBSUssd0JBQXdCTCxRQUFRLGdEQUFSLENBQTVCOztBQUVBLElBQUlNLFVBQVUsRUFBZDtBQUNBLElBQUlDLFlBQVksS0FBaEI7O0FBRUEsU0FBU0MsTUFBVDtBQUNDLG9CQUFxQkMsY0FEdEI7QUFFQywwQkFBMkJDLG9CQUY1QjtBQUdDLDhCQUErQkMsd0JBSGhDO0FBSUMscUJBQXNCQyxRQUp2QjtBQUtDLGtCQUFtQkMsS0FMcEI7QUFNQyx1QkFBd0JDLFVBTnpCLEVBT0NDLGtCQVBELEVBUUNDLE9BUkQsRUFTRTtBQUNBUCxtQkFBaUJWLEVBQUVrQixLQUFGLENBQVFSLGNBQVIsS0FBMkIsRUFBNUM7QUFD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QUFLL0UsSUFBN0IsQ0FBdkIsRUFBMkQsVUFBUytGLEdBQVQsRUFBY2MsT0FBZCxFQUF1QjtBQUNoRixVQUFJZCxHQUFKLEVBQVM7QUFDUCxjQUFNQSxHQUFOO0FBQ0Q7O0FBRUR0QixXQUFLc0IsR0FBTCxFQUFVYyxXQUFXQSxRQUFRQyxRQUFSLEVBQXJCO0FBQ0QsS0FORDtBQU9ELEdBZEQ7QUFlRDs7QUFFRCxTQUFTQyxvQkFBVCxHQUFnQztBQUM5QixTQUFPLFVBQVNDLE9BQVQsRUFBa0JDLFFBQWxCLEVBQTRCQyxJQUE1QixFQUFrQztBQUN2QyxRQUFJNUcsU0FBSixFQUFlO0FBQ2JELGNBQVFzRCxJQUFSLENBQWF1RCxJQUFiO0FBQ0QsS0FGRCxNQUVPO0FBQ0xBO0FBQ0Q7QUFDRixHQU5EO0FBT0Q7O0FBRUQ3QixPQUFPOEIsT0FBUCxHQUFpQjtBQUNmUCxpQkFBZSxDQUFDLE1BQUQsRUFBU3JHLE1BQVQsQ0FEQTtBQUVmLDBCQUF3QixDQUFDLFNBQUQsRUFBWW9HLGlCQUFaLENBRlQ7QUFHZiwrQkFBNkIsQ0FBQyxTQUFELEVBQVlJLG9CQUFaO0FBSGQsQ0FBakIiLCJmaWxlIjoia2FybWEtd2VicGFjay5qcyIsInNvdXJjZXNDb250ZW50IjpbInZhciBfID0gcmVxdWlyZSgnbG9kYXNoJylcbnZhciBwYXRoID0gcmVxdWlyZSgncGF0aCcpXG52YXIgYXN5bmMgPSByZXF1aXJlKCdhc3luYycpXG52YXIgd2VicGFja0Rldk1pZGRsZXdhcmUgPSByZXF1aXJlKCd3ZWJwYWNrLWRldi1taWRkbGV3YXJlJylcbnZhciB3ZWJwYWNrID0gcmVxdWlyZSgnd2VicGFjaycpXG52YXIgU2luZ2xlRW50cnlEZXBlbmRlbmN5ID0gcmVxdWlyZSgnd2VicGFjay9saWIvZGVwZW5kZW5jaWVzL1NpbmdsZUVudHJ5RGVwZW5kZW5jeScpXG5cbnZhciBibG9ja2VkID0gW11cbnZhciBpc0Jsb2NrZWQgPSBmYWxzZVxuXG5mdW5jdGlvbiBQbHVnaW4oXG5cdC8qIGNvbmZpZy53ZWJwYWNrICovIHdlYnBhY2tPcHRpb25zLFxuXHQvKiBjb25maWcud2VicGFja1NlcnZlciAqLyB3ZWJwYWNrU2VydmVyT3B0aW9ucyxcblx0LyogY29uZmlnLndlYnBhY2tNaWRkbGV3YXJlICovIHdlYnBhY2tNaWRkbGV3YXJlT3B0aW9ucyxcblx0LyogY29uZmlnLmJhc2VQYXRoICovIGJhc2VQYXRoLFxuXHQvKiBjb25maWcuZmlsZXMgKi8gZmlsZXMsXG5cdC8qIGNvbmZpZy5mcmFtZXdvcmtzICovIGZyYW1ld29ya3MsXG5cdGN1c3RvbUZpbGVIYW5kbGVycyxcblx0ZW1pdHRlclxuKSB7XG4gIHdlYnBhY2tPcHRpb25zID0gXy5jbG9uZSh3ZWJwYWNrT3B0aW9ucykgfHwge31cbiAgd2VicGFja01pZGRsZXdhcmVPcHRpb25zID0gXy5jbG9uZSh3ZWJwYWNrTWlkZGxld2FyZU9wdGlvbnMgfHwgd2VicGFja1NlcnZlck9wdGlvbnMpIHx8IHt9XG5cbiAgdmFyIGFwcGx5T3B0aW9ucyA9IEFycmF5LmlzQXJyYXkod2VicGFja09wdGlvbnMpID8gd2VicGFja09wdGlvbnMgOiBbd2VicGFja09wdGlvbnNdXG4gIHZhciBpbmNsdWRlSW5kZXggPSBhcHBseU9wdGlvbnMubGVuZ3RoID4gMVxuXG4gIGFwcGx5T3B0aW9ucy5mb3JFYWNoKGZ1bmN0aW9uKHdlYnBhY2tPcHRpb25zLCBpbmRleCkge1xuICAgIC8vIFRoZSB3ZWJwYWNrIHRpZXIgb3ducyB0aGUgd2F0Y2ggYmVoYXZpb3Igc28gd2Ugd2FudCB0byBmb3JjZSBpdCBpbiB0aGUgY29uZmlnXG4gICAgd2VicGFja09wdGlvbnMud2F0Y2ggPSB0cnVlXG5cbiAgICAvLyBXZWJwYWNrIDIuMS4wLWJldGEuNysgd2lsbCB0aHJvdyBpbiBlcnJvciBpZiBib3RoIGVudHJ5IGFuZCBwbHVnaW5zIGFyZSBub3Qgc3BlY2lmaWVkIGluIG9wdGlvbnNcbiAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vd2VicGFjay93ZWJwYWNrL2NvbW1pdC9iM2JjNTQyNzk2OWUxNWZkMzY2M2Q5YTFjNTdkYmQxZWIyYzk0ODA1XG4gICAgaWYgKCF3ZWJwYWNrT3B0aW9ucy5lbnRyeSkge1xuICAgICAgd2VicGFja09wdGlvbnMuZW50cnkgPSBmdW5jdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHt9XG4gICAgICB9XG4gICAgfTtcblxuICAgIGlmICghd2VicGFja09wdGlvbnMub3V0cHV0KSB7XG4gICAgICB3ZWJwYWNrT3B0aW9ucy5vdXRwdXQgPSB7fVxuICAgIH07XG5cbiAgICAvLyBXaGVuIHVzaW5nIGFuIGFycmF5LCBldmVuIG9mIGxlbmd0aCAxLCB3ZSB3YW50IHRvIGluY2x1ZGUgdGhlIGluZGV4IHZhbHVlIGZvciB0aGUgYnVpbGQuXG4gICAgLy8gVGhpcyBpcyBkdWUgdG8gdGhlIHdheSB0aGF0IHRoZSBkZXYgc2VydmVyIGV4cG9zZXMgY29tbW9uUGF0aCBmb3IgYnVpbGQgb3V0cHV0LlxuICAgIHZhciBpbmRleFBhdGggPSBpbmNsdWRlSW5kZXggPyBpbmRleCArICcvJyA6ICcnXG4gICAgdmFyIHB1YmxpY1BhdGggPSBpbmRleFBhdGggIT09ICcnID8gaW5kZXhQYXRoICsgJy8nIDogJydcblxuICAgIC8vIE11c3QgaGF2ZSB0aGUgY29tbW9uIF9rYXJtYV93ZWJwYWNrXyBwcmVmaXggb24gcGF0aCBoZXJlIHRvIGF2b2lkXG4gICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL3dlYnBhY2svd2VicGFjay9pc3N1ZXMvNjQ1XG4gICAgd2VicGFja09wdGlvbnMub3V0cHV0LnBhdGggPSAnL19rYXJtYV93ZWJwYWNrXy8nICsgaW5kZXhQYXRoXG4gICAgd2VicGFja09wdGlvbnMub3V0cHV0LnB1YmxpY1BhdGggPSAnL19rYXJtYV93ZWJwYWNrXy8nICsgcHVibGljUGF0aFxuICAgIHdlYnBhY2tPcHRpb25zLm91dHB1dC5maWxlbmFtZSA9ICdbbmFtZV0nXG4gICAgaWYgKGluY2x1ZGVJbmRleCkge1xuICAgICAgd2VicGFja09wdGlvbnMub3V0cHV0Lmpzb25wRnVuY3Rpb24gPSAnd2VicGFja0pzb25wJyArIGluZGV4XG4gICAgfVxuICAgIHdlYnBhY2tPcHRpb25zLm91dHB1dC5jaHVua0ZpbGVuYW1lID0gJ1tpZF0uYnVuZGxlLmpzJ1xuICB9KVxuXG4gIHRoaXMuZW1pdHRlciA9IGVtaXR0ZXJcbiAgdGhpcy53cmFwTW9jaGEgPSBmcmFtZXdvcmtzLmluZGV4T2YoJ21vY2hhJykgPj0gMCAmJiBpbmNsdWRlSW5kZXhcbiAgdGhpcy5vcHRpb25zQ291bnQgPSBhcHBseU9wdGlvbnMubGVuZ3RoXG4gIHRoaXMuZmlsZXMgPSBbXVxuICB0aGlzLmJhc2VQYXRoID0gYmFzZVBhdGhcbiAgdGhpcy53YWl0aW5nID0gW11cblxuICB2YXIgY29tcGlsZXJcbiAgdHJ5IHtcbiAgICBjb21waWxlciA9IHdlYnBhY2sod2VicGFja09wdGlvbnMpXG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKGUuc3RhY2sgfHwgZSlcbiAgICBpZiAoZS5kZXRhaWxzKSB7XG4gICAgICBjb25zb2xlLmVycm9yKGUuZGV0YWlscylcbiAgICB9XG4gICAgdGhyb3cgZVxuICB9XG5cbiAgdmFyIGFwcGx5UGx1Z2lucyA9IGNvbXBpbGVyLmNvbXBpbGVycyB8fCBbY29tcGlsZXJdXG5cbiAgYXBwbHlQbHVnaW5zLmZvckVhY2goZnVuY3Rpb24oY29tcGlsZXIpIHtcbiAgICBjb21waWxlci5wbHVnaW4oJ3RoaXMtY29tcGlsYXRpb24nLCBmdW5jdGlvbihjb21waWxhdGlvbiwgcGFyYW1zKSB7XG4gICAgICBjb21waWxhdGlvbi5kZXBlbmRlbmN5RmFjdG9yaWVzLnNldChTaW5nbGVFbnRyeURlcGVuZGVuY3ksIHBhcmFtcy5ub3JtYWxNb2R1bGVGYWN0b3J5KVxuICAgIH0pXG4gICAgY29tcGlsZXIucGx1Z2luKCdtYWtlJywgdGhpcy5tYWtlLmJpbmQodGhpcykpXG4gIH0sIHRoaXMpO1xuXG4gIFsnaW52YWxpZCcsICd3YXRjaC1ydW4nLCAncnVuJ10uZm9yRWFjaChmdW5jdGlvbihuYW1lKSB7XG4gICAgY29tcGlsZXIucGx1Z2luKG5hbWUsIGZ1bmN0aW9uKF8sIGNhbGxiYWNrKSB7XG4gICAgICBpc0Jsb2NrZWQgPSB0cnVlXG5cbiAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2FsbGJhY2soKVxuICAgICAgfVxuICAgIH0pXG4gIH0pXG5cbiAgY29tcGlsZXIucGx1Z2luKCdkb25lJywgZnVuY3Rpb24oc3RhdHMpIHtcbiAgICB2YXIgYXBwbHlTdGF0cyA9IEFycmF5LmlzQXJyYXkoc3RhdHMuc3RhdHMpID8gc3RhdHMuc3RhdHMgOiBbc3RhdHNdXG4gICAgdmFyIGFzc2V0cyA9IFtdXG4gICAgdmFyIG5vQXNzZXRzID0gZmFsc2VcblxuICAgIGFwcGx5U3RhdHMuZm9yRWFjaChmdW5jdGlvbihzdGF0cykge1xuICAgICAgc3RhdHMgPSBzdGF0cy50b0pzb24oKVxuXG4gICAgICBhc3NldHMucHVzaC5hcHBseShhc3NldHMsIHN0YXRzLmFzc2V0cylcbiAgICAgIGlmIChzdGF0cy5hc3NldHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIG5vQXNzZXRzID0gdHJ1ZVxuICAgICAgfVxuICAgIH0pXG5cbiAgICBpZiAoIXRoaXMud2FpdGluZyB8fCB0aGlzLndhaXRpbmcubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aGlzLm5vdGlmeUthcm1hQWJvdXRDaGFuZ2VzKClcbiAgICB9XG5cbiAgICBpZiAodGhpcy53YWl0aW5nICYmICFub0Fzc2V0cykge1xuICAgICAgdmFyIHcgPSB0aGlzLndhaXRpbmdcblxuICAgICAgdGhpcy53YWl0aW5nID0gbnVsbFxuICAgICAgdy5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgIGNiKClcbiAgICAgIH0pXG4gICAgfVxuXG4gICAgaXNCbG9ja2VkID0gZmFsc2VcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJsb2NrZWQubGVuZ3RoOyBpKyspIHtcbiAgICAgIGJsb2NrZWRbaV0oKVxuICAgIH1cbiAgICBibG9ja2VkID0gW11cbiAgfS5iaW5kKHRoaXMpKVxuICBjb21waWxlci5wbHVnaW4oJ2ludmFsaWQnLCBmdW5jdGlvbigpIHtcbiAgICBpZiAoIXRoaXMud2FpdGluZykge1xuICAgICAgdGhpcy53YWl0aW5nID0gW11cbiAgICB9XG4gIH0uYmluZCh0aGlzKSlcblxuICB3ZWJwYWNrTWlkZGxld2FyZU9wdGlvbnMucHVibGljUGF0aCA9ICcvX2thcm1hX3dlYnBhY2tfLydcbiAgdmFyIG1pZGRsZXdhcmUgPSB0aGlzLm1pZGRsZXdhcmUgPSBuZXcgd2VicGFja0Rldk1pZGRsZXdhcmUoY29tcGlsZXIsIHdlYnBhY2tNaWRkbGV3YXJlT3B0aW9ucylcblxuICBjdXN0b21GaWxlSGFuZGxlcnMucHVzaCh7XG4gICAgdXJsUmVnZXg6IC9eXFwvX2thcm1hX3dlYnBhY2tfXFwvLiovLFxuICAgIGhhbmRsZXI6IGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgICBtaWRkbGV3YXJlKHJlcSwgcmVzLCBmdW5jdGlvbigpIHtcbiAgICAgICAgcmVzLnN0YXR1c0NvZGUgPSA0MDRcbiAgICAgICAgcmVzLmVuZCgnTm90IGZvdW5kJylcbiAgICAgIH0pXG4gICAgfVxuICB9KVxuXG4gIGVtaXR0ZXIub24oJ2V4aXQnLCBmdW5jdGlvbihkb25lKSB7XG4gICAgbWlkZGxld2FyZS5jbG9zZSgpXG4gICAgZG9uZSgpXG4gIH0pXG59XG5cblBsdWdpbi5wcm90b3R5cGUubm90aWZ5S2FybWFBYm91dENoYW5nZXMgPSBmdW5jdGlvbigpIHtcbiAgLy8gRm9yY2UgYSByZWJ1aWxkXG4gIHRoaXMuZW1pdHRlci5yZWZyZXNoRmlsZXMoKVxufVxuXG5QbHVnaW4ucHJvdG90eXBlLmFkZEZpbGUgPSBmdW5jdGlvbihlbnRyeSkge1xuICBpZiAodGhpcy5maWxlcy5pbmRleE9mKGVudHJ5KSA+PSAwKSB7XG4gICAgcmV0dXJuXG4gIH1cbiAgdGhpcy5maWxlcy5wdXNoKGVudHJ5KVxuXG4gIHJldHVybiB0cnVlXG59XG5cblBsdWdpbi5wcm90b3R5cGUubWFrZSA9IGZ1bmN0aW9uKGNvbXBpbGF0aW9uLCBjYWxsYmFjaykge1xuICBhc3luYy5mb3JFYWNoKHRoaXMuZmlsZXMuc2xpY2UoKSwgZnVuY3Rpb24oZmlsZSwgY2FsbGJhY2spIHtcbiAgICB2YXIgZW50cnkgPSBmaWxlXG5cbiAgICBpZiAodGhpcy53cmFwTW9jaGEpIHtcbiAgICAgIGVudHJ5ID0gcmVxdWlyZS5yZXNvbHZlKCcuL21vY2hhLWVudi1sb2FkZXInKSArICchJyArIGVudHJ5XG4gICAgfVxuXG4gICAgdmFyIGRlcCA9IG5ldyBTaW5nbGVFbnRyeURlcGVuZGVuY3koZW50cnkpXG5cbiAgICBjb21waWxhdGlvbi5hZGRFbnRyeSgnJywgZGVwLCBwYXRoLnJlbGF0aXZlKHRoaXMuYmFzZVBhdGgsIGZpbGUpLnJlcGxhY2UoL1xcXFwvZywgJy8nKSwgZnVuY3Rpb24oKSB7XG4gICAgICAvLyBJZiB0aGUgbW9kdWxlIGZhaWxzIGJlY2F1c2Ugb2YgYW4gRmlsZSBub3QgZm91bmQgZXJyb3IsIHJlbW92ZSB0aGUgdGVzdCBmaWxlXG4gICAgICBpZiAoZGVwLm1vZHVsZSAmJiBkZXAubW9kdWxlLmVycm9yICYmXG4gICAgICAgIGRlcC5tb2R1bGUuZXJyb3IuZXJyb3IgJiZcbiAgICAgICAgZGVwLm1vZHVsZS5lcnJvci5lcnJvci5jb2RlID09PSAnRU5PRU5UJykge1xuICAgICAgICB0aGlzLmZpbGVzID0gdGhpcy5maWxlcy5maWx0ZXIoZnVuY3Rpb24oZikge1xuICAgICAgICAgIHJldHVybiBmaWxlICE9PSBmXG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMubWlkZGxld2FyZS5pbnZhbGlkYXRlKClcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKClcbiAgICB9LmJpbmQodGhpcykpXG4gIH0uYmluZCh0aGlzKSwgY2FsbGJhY2spXG59XG5cblBsdWdpbi5wcm90b3R5cGUucmVhZEZpbGUgPSBmdW5jdGlvbihmaWxlLCBjYWxsYmFjaykge1xuICB2YXIgbWlkZGxld2FyZSA9IHRoaXMubWlkZGxld2FyZVxuICB2YXIgb3B0aW9uc0NvdW50ID0gdGhpcy5vcHRpb25zQ291bnRcblxuICB2YXIgZG9SZWFkID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKG9wdGlvbnNDb3VudCA+IDEpIHtcbiAgICAgIGFzeW5jLnRpbWVzKG9wdGlvbnNDb3VudCwgZnVuY3Rpb24oaWR4LCBjYWxsYmFjaykge1xuICAgICAgICBtaWRkbGV3YXJlLmZpbGVTeXN0ZW0ucmVhZEZpbGUoJy9fa2FybWFfd2VicGFja18vJyArIGlkeCArICcvJyArIGZpbGUucmVwbGFjZSgvXFxcXC9nLCAnLycpLCBjYWxsYmFjaylcbiAgICAgIH0sIGZ1bmN0aW9uKGVyciwgY29udGVudHMpIHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRlbnRzID0gY29udGVudHMucmVkdWNlKGZ1bmN0aW9uKGFyciwgeCkge1xuICAgICAgICAgIGlmICghYXJyKSB7XG4gICAgICAgICAgICByZXR1cm4gW3hdXG4gICAgICAgICAgfTtcbiAgICAgICAgICBhcnIucHVzaChuZXcgQnVmZmVyKCdcXG4nKSwgeClcblxuICAgICAgICAgIHJldHVybiBhcnJcbiAgICAgICAgfSwgbnVsbClcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgQnVmZmVyLmNvbmNhdChjb250ZW50cykpXG4gICAgICB9KVxuICAgIH0gZWxzZSB7XG4gICAgICB0cnkge1xuICAgICAgICB2YXIgZmlsZUNvbnRlbnRzID0gbWlkZGxld2FyZS5maWxlU3lzdGVtLnJlYWRGaWxlU3luYygnL19rYXJtYV93ZWJwYWNrXy8nICsgZmlsZS5yZXBsYWNlKC9cXFxcL2csICcvJykpXG5cbiAgICAgICAgY2FsbGJhY2sodW5kZWZpbmVkLCBmaWxlQ29udGVudHMpXG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIC8vIElmIHRoaXMgaXMgYW4gZXJyb3IgZnJvbSBgcmVhZEZpbGVTeW5jYCBtZXRob2QsIHdhaXQgZm9yIHRoZSBuZXh0IHRpY2suXG4gICAgICAgIC8vIENyZWRpdCAjNjkgQG1ld2RyaWxsZXJcbiAgICAgICAgaWYgKGUuY29kZSA9PT0gJ0VOT0VOVCcpIHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIHF1b3Rlc1xuICAgICAgICAgIHRoaXMud2FpdGluZyA9IFtwcm9jZXNzLm5leHRUaWNrLmJpbmQocHJvY2VzcywgdGhpcy5yZWFkRmlsZS5iaW5kKHRoaXMsIGZpbGUsIGNhbGxiYWNrKSldXG5cbiAgICAgICAgICAvLyB0aHJvdyBvdGhlcndpc2VcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjYWxsYmFjayhlKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9LmJpbmQodGhpcylcblxuICBpZiAoIXRoaXMud2FpdGluZykge1xuICAgIGRvUmVhZCgpXG4gIH0gZWxzZSB7XG4gICAgLy8gUmV0cnkgdG8gcmVhZCBvbmNlIGEgYnVpbGQgaXMgZmluaXNoZWRcbiAgICAvLyBkbyBpdCBvbiBwcm9jZXNzLm5leHRUaWNrIHRvIGNhdGNoIGNoYW5nZXMgd2hpbGUgYnVpbGRpbmdcbiAgICB0aGlzLndhaXRpbmcucHVzaChwcm9jZXNzLm5leHRUaWNrLmJpbmQocHJvY2VzcywgdGhpcy5yZWFkRmlsZS5iaW5kKHRoaXMsIGZpbGUsIGNhbGxiYWNrKSkpXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlUHJlcHJvY2Vzb3IoLyogY29uZmlnLmJhc2VQYXRoICovIGJhc2VQYXRoLCB3ZWJwYWNrUGx1Z2luKSB7XG4gIHJldHVybiBmdW5jdGlvbihjb250ZW50LCBmaWxlLCBkb25lKSB7XG4gICAgaWYgKHdlYnBhY2tQbHVnaW4uYWRkRmlsZShmaWxlLnBhdGgpKSB7XG4gICAgICAvLyByZWNvbXBpbGUgYXMgd2UgaGF2ZSBhbiBhc3NldCB0aGF0IHdlIGhhdmUgbm90IHNlZW4gYmVmb3JlXG4gICAgICB3ZWJwYWNrUGx1Z2luLm1pZGRsZXdhcmUuaW52YWxpZGF0ZSgpXG4gICAgfVxuXG4gICAgLy8gcmVhZCBibG9ja3MgdW50aWwgYnVuZGxlIGlzIGRvbmVcbiAgICB3ZWJwYWNrUGx1Z2luLnJlYWRGaWxlKHBhdGgucmVsYXRpdmUoYmFzZVBhdGgsIGZpbGUucGF0aCksIGZ1bmN0aW9uKGVyciwgY29udGVudCkge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICB0aHJvdyBlcnJcbiAgICAgIH1cblxuICAgICAgZG9uZShlcnIsIGNvbnRlbnQgJiYgY29udGVudC50b1N0cmluZygpKVxuICAgIH0pXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlV2VicGFja0Jsb2NrZXIoKSB7XG4gIHJldHVybiBmdW5jdGlvbihyZXF1ZXN0LCByZXNwb25zZSwgbmV4dCkge1xuICAgIGlmIChpc0Jsb2NrZWQpIHtcbiAgICAgIGJsb2NrZWQucHVzaChuZXh0KVxuICAgIH0gZWxzZSB7XG4gICAgICBuZXh0KClcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIHdlYnBhY2tQbHVnaW46IFsndHlwZScsIFBsdWdpbl0sXG4gICdwcmVwcm9jZXNzb3I6d2VicGFjayc6IFsnZmFjdG9yeScsIGNyZWF0ZVByZXByb2Nlc29yXSxcbiAgJ21pZGRsZXdhcmU6d2VicGFja0Jsb2NrZXInOiBbJ2ZhY3RvcnknLCBjcmVhdGVXZWJwYWNrQmxvY2tlcl1cbn1cbiJdfQ==
