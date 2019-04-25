const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const expressLogging = require("express-logging");
const queryString = require("querystring");
const path = require("path");
const getPort = require("get-port");
const chokidar = require("chokidar");
const jwtDecode = require("jwt-decode");
const chalk = require("chalk");
const {
  NETLIFYDEVLOG,
  // NETLIFYDEVWARN,
  NETLIFYDEVERR
} = require("netlify-cli-logo");

const { findModuleDir, findHandler } = require("./finders");

const defaultPort = 34567;

function handleErr(err, response) {
  response.statusCode = 500;
  response.write(
    `${NETLIFYDEVERR} Function invocation failed: ` + err.toString()
  );
  response.end();
  console.log(`${NETLIFYDEVERR} Error during invocation: `, err); // eslint-disable-line no-console
}

// function getHandlerPath(functionPath) {
//   if (functionPath.match(/\.js$/)) {
//     return functionPath;
//   }
//   return path.join(functionPath, `${path.basename(functionPath)}.js`);
// }

function buildClientContext(headers) {
  // inject a client context based on auth header, ported over from netlify-lambda (https://github.com/netlify/netlify-lambda/pull/57)
  if (!headers.authorization) return;

  const parts = headers.authorization.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return;

  try {
    return {
      identity: {
        url: "NETLIFY_LAMBDA_LOCALLY_EMULATED_IDENTITY_URL",
        token: "NETLIFY_LAMBDA_LOCALLY_EMULATED_IDENTITY_TOKEN"
      },
      user: jwtDecode(parts[1])
    };
  } catch (_) {
    // Ignore errors - bearer token is not a JWT, probably not intended for us
  }
}

function createHandler(dir) {
  const functions = {};
  fs.readdirSync(dir).forEach(file => {
    if (dir === "node_modules") {
      return;
    }
    const functionPath = path.resolve(path.join(dir, file));
    const handlerPath = findHandler(functionPath);
    if (!handlerPath) {
      return;
    }
    if (path.extname(functionPath) === ".js") {
      functions[file.replace(/\.js$/, "")] = {
        functionPath,
        moduleDir: findModuleDir(functionPath)
      };
    } else if (fs.lstatSync(functionPath).isDirectory()) {
      functions[file] = {
        functionPath: handlerPath,
        moduleDir: findModuleDir(functionPath)
      };
    }
  });

  Object.keys(functions).forEach(name => {
    const fn = functions[name];
    const clearCache = action => () => {
      console.log(
        `${NETLIFYDEVLOG} function ${chalk.yellow(
          name
        )} ${action}, reloading...`
      ); // eslint-disable-line no-console
      const before = module.paths;
      module.paths = [fn.moduleDir];
      delete require.cache[require.resolve(fn.functionPath)];
      module.paths = before;
    };
    const pathsToWatch = [fn.functionPath];
    if (fn.moduleDir) {
      pathsToWatch.push(path.join(fn.moduleDir, "package.json"));
    }
    fn.watcher = chokidar.watch(pathsToWatch, {
      ignored: /node_modules/
    });
    fn.watcher
      .on("add", clearCache("added"))
      .on("change", clearCache("modified"))
      .on("unlink", clearCache("deleted"));
  });

  return function(request, response) {
    // handle proxies without path re-writes (http-servr)
    const cleanPath = request.path.replace(/^\/.netlify\/functions/, "");

    const func = cleanPath.split("/").filter(function(e) {
      return e;
    })[0];
    if (!functions[func]) {
      response.statusCode = 404;
      response.end("Function not found...");
      return;
    }
    const { functionPath, moduleDir } = functions[func];
    let handler;
    let before = module.paths;
    try {
      module.paths = [moduleDir];
      handler = require(functionPath);
      if (typeof handler.handler !== "function") {
        throw new Error(
          `function ${functionPath} must export a function named handler`
        );
      }
      module.paths = before;
    } catch (error) {
      module.paths = before;
      handleErr(error, response);
      return;
    }

    var isBase64Encoded = false;
    var body = request.body;

    if (body instanceof Buffer) {
      isBase64Encoded = true;
      body = body.toString("base64");
    } else if (typeof body === "string") {
      // body is already processed as string
    } else {
      body = "";
    }

    const lambdaRequest = {
      path: request.path,
      httpMethod: request.method,
      queryStringParameters: queryString.parse(request.url.split(/\?(.+)/)[1]),
      headers: request.headers,
      body: body,
      isBase64Encoded: isBase64Encoded
    };

    let callbackWasCalled = false;
    const callback = createCallback(response);
    const promise = handler.handler(
      lambdaRequest,
      { clientContext: buildClientContext(request.headers) || {} },
      callback
    );
    /** guard against using BOTH async and callback */
    if (callbackWasCalled && promise && typeof promise.then === "function") {
      throw new Error(
        "Error: your function seems to be using both a callback and returning a promise (aka async function). This is invalid, pick one. (Hint: async!)"
      );
    } else {
      // it is definitely an async function with no callback called, good.
      promiseCallback(promise, callback);
    }

    /** need to keep createCallback in scope so we can know if cb was called AND handler is async */
    function createCallback(response) {
      return function(err, lambdaResponse) {
        callbackWasCalled = true;
        if (err) {
          return handleErr(err, response);
        }
        if (lambdaResponse === undefined) {
          return handleErr(
            "lambda response was undefined. check your function code again.",
            response
          );
        }
        if (!Number(lambdaResponse.statusCode)) {
          console.log(
            `${NETLIFYDEVERR} Your function response must have a numerical statusCode. You gave: $`,
            lambdaResponse.statusCode
          );
          return handleErr("Incorrect function response statusCode", response);
        }
        if (typeof lambdaResponse.body !== "string") {
          console.log(
            `${NETLIFYDEVERR} Your function response must have a string body. You gave:`,
            lambdaResponse.body
          );
          return handleErr("Incorrect function response body", response);
        }

        response.statusCode = lambdaResponse.statusCode;
        // eslint-disable-line guard-for-in
        for (const key in lambdaResponse.headers) {
          response.setHeader(key, lambdaResponse.headers[key]);
        }
        response.write(
          lambdaResponse.isBase64Encoded
            ? Buffer.from(lambdaResponse.body, "base64")
            : lambdaResponse.body
        );
        response.end();
      };
    }
  };
}

function promiseCallback(promise, callback) {
  if (!promise) return; // means no handler was written
  if (typeof promise.then !== "function") return;
  if (typeof callback !== "function") return;

  promise.then(
    function(data) {
      console.log("hellooo");
      callback(null, data);
    },
    function(err) {
      callback(err, null);
    }
  );
}

async function serveFunctions(settings) {
  const app = express();
  const dir = settings.functionsDir;
  const port = await getPort({
    port: assignLoudly(settings.port, defaultPort)
  });

  app.use(
    bodyParser.text({
      limit: "6mb",
      type: ["text/*", "application/json", "multipart/form-data"]
    })
  );
  app.use(bodyParser.raw({ limit: "6mb", type: "*/*" }));
  app.use(
    expressLogging(console, {
      blacklist: ["/favicon.ico"]
    })
  );

  app.get("/favicon.ico", function(req, res) {
    res.status(204).end();
  });
  app.all("*", createHandler(dir));

  app.listen(port, function(err) {
    if (err) {
      console.error(`${NETLIFYDEVERR} Unable to start lambda server: `, err); // eslint-disable-line no-console
      process.exit(1);
    }

    // add newline because this often appears alongside the client devserver's output
    console.log(`\n${NETLIFYDEVLOG} Lambda server is listening on ${port}`); // eslint-disable-line no-console
  });

  return Promise.resolve({
    port
  });
}

module.exports = { serveFunctions };

// if first arg is undefined, use default, but tell user about it in case it is unintentional
function assignLoudly(
  optionalValue,
  fallbackValue,
  tellUser = dV =>
    console.log(`${NETLIFYDEVLOG} No port specified, using defaultPort of `, dV) // eslint-disable-line no-console
) {
  if (fallbackValue === undefined) throw new Error("must have a fallbackValue");
  if (fallbackValue !== optionalValue && optionalValue === undefined) {
    tellUser(fallbackValue);
    return fallbackValue;
  }
  return optionalValue;
}
