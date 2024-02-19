const fs = require("fs");
const fsp = fs.promises;
const mime = require("mime");
const { LRUCache } = require("lru-cache");
const http = require("http");
require("dotenv").config({ path: "../.env" });
const { Server } = require("socket.io");

const { Configuration, OpenAIApi } = require("openai");
const OPEN_AI_KEY = process.env.OPENAI_API_KEY;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const LLM_KEY = process.env.LLM_KEY;
// const WebSocketServer = require('websocket').server;

const DATAPATH = process.env.DATAPATH || "./data";
for (const subdir of ["history", "files"]) {
  // other categories of data?
  if (!fs.existsSync(DATAPATH + "/" + subdir)) {
    fs.mkdirSync(DATAPATH + "/" + subdir);
  }
}

/******************
 *                *
 * The Web Server *
 *                *
 ******************/

// what web port to listen to? Common values for development systems
// are 8000, 8080, 5000, 3000, etc. Round numbers greater than 1024.
const PORT = process.env.PORT || 8200;
const PUBLIC = process.env.PUBLIC || false;
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME || "editor.";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

// create the server module
let server = http.createServer(async (req, res) => {
  console.log("Got request!", req.method, req.url);

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, "http://localhost/");
  } catch (e) {
    console.log("unknown request", req.url, e);
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("Couldn't find your URL...");
    return;
  }
  // get the file path out of the URL, stripping any "query string"
  let path = parsedUrl.pathname;
  console.log("path:", path);

  async function getBody(req) {
    let body = [];
    for await (const chunk of req) {
      body.push(chunk);
    }
    return Buffer.concat(body).toString();
  }

  // then, based on the file path:
  switch (path.split("/", 3).join("/")) {
    //    case '/':
    //      // 200 OK nothing to see here.
    //      res.writeHead(200, {'Content-Type': 'text/html'});
    //      res.end("Nothing to see here.");
    //      break;
    case "/assembly-user-token":
      try {
        const response = await fetch(
          "https://api.assemblyai.com/v2/realtime/token", // use account token to get a temp user token
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              authorization: ASSEMBLYAI_KEY,
            },
            body: JSON.stringify({ expires_in: 3600 }), // can set a TTL timer in seconds.
          },
        );
        const data = await response.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        console.log(error);
        const { status, statusText, headers, body } = error.response;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status, statusText, headers, body }));
      }
      break;
    case "/api/frontend-key":
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key: LLM_KEY }));
      break;
    case "/api/llm-query":
      // Verify llmkey header matches the env var
      if (LLM_KEY !== req.headers["llmkey"]) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        const start = Date.now();
        let body = await getBody(req);
        let options = JSON.parse(body);
        console.log("Processing LLM query for", options);
        if (!openai.cache.has(body)) {
          let response;
          console.log(`${options.model} cache miss`);
          response = await openai.api.createChatCompletion(options);
          openai.cache.set(body, response);
        } else {
          console.log("GPT cache hit");
        }
        const response = openai.cache.get(body);
        // console.log("Got response", response);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: response.data }));
        console.log("LLM query took", Date.now() - start, "ms");
      } catch (err) {
        console.log("GPT Error", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Couldn't complete GPT query..." }));
      }
      break;
    case "/api/llm-query-streaming":
      if (req.method !== "POST") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Must be a POST request" }));
        break;
      }
      // Verify llmkey header matches the env var
      if (LLM_KEY !== req.headers["llmkey"]) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        const start = Date.now();
        let body = await getBody(req);
        let options = JSON.parse(body);
        console.log("Processing LLM query for", options);
        const { rambleBoxId, level, replace } = options;
        delete options.rambleBoxId;
        delete options.level;
        delete options.replace;
        if (!openai.cache.has(body)) {
          console.log(`${options.model} cache miss`);
          const response = await openai.api.createChatCompletion(
            { ...options, stream: true },
            { responseType: "stream" },
          );
          // for the regular response, we have response?.data?.choices[0]?.message?.content;
          const chatgptResponse = { data: "" };

          //https://github.com/openai/openai-node/issues/18#issuecomment-1369996933
          response.data.on("data", (data) => {
            const lines = data
              .toString()
              .split("\n")
              .filter((line) => line.trim() !== "");
            for (const line of lines) {
              const message = line.replace(/^data: /, "");
              if (message === "[DONE]") {
                openai.cache.set(body, chatgptResponse);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ data: chatgptResponse.data }));
                return; // Stream finished
              }
              try {
                const parsed = JSON.parse(message);
                const text = parsed.choices[0].delta.content;
                // console.log(text);
                if (text) {
                  chatgptResponse.data += text;
                  // console.log({ rambleBoxId, level, content: chatgptResponse.data })
                  io.emit("chatgptResChunk", {
                    rambleBoxId,
                    level,
                    content: chatgptResponse.data,
                    timeRequested: start.toString(),
                    replace,
                  });
                }
                // res.write(`data: ${text}\n\n`)
              } catch (error) {
                console.error(
                  "Could not JSON parse stream message",
                  message,
                  error,
                );
              }
            }
          });
        } else {
          console.log("GPT cache hit");
          res.writeHead(200, { "Content-Type": "application/json" });
          const chatgptResponse = openai.cache.get(body);
          console.log({ data: chatgptResponse.data });
          res.end(JSON.stringify({ data: chatgptResponse.data }));
        }
        // const response = openai.cache.get(body);
        // // console.log("Got response", response);
        // res.writeHead(200, { "Content-Type": "application/json" });
        // res.end(JSON.stringify({ data: response.data }));
        console.log("LLM query took", Date.now() - start, "ms");
      } catch (err) {
        // console.log("GPT Error", err, Object.keys(err), err.response?.data);
        console.log("GPT Error", err);
        res.end(JSON.stringify({ error: "Couldn't complete GPT query..." }));
      }
      break;
    case "/api/history":
      if (req.method == "GET") {
        // list full history
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await api.allHistory()));
      } else if (req.method == "POST" || req.method == "PUT") {
        // save a history entry
        try {
          let body = await getBody(req);
          let historyEntry = JSON.parse(body);
          console.log("got historyEntry", historyEntry.time);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: await api.saveHistory(historyEntry.time, historyEntry),
            }),
          );
        } catch (err) {
          console.log("Error parsing history", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: false,
              message: "Couldn't parse history...",
            }),
          );
        }
      }
      break;
    case "/api/files":
      if (req.method == "GET") {
        // get all files by participant id
        let query = parsedUrl.searchParams;
        let pId = query.get("pId");
        // make sure pId is a valid uuidv4 string
        if (
          !pId.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          )
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: false, message: "Invalid pId" }));
          return;
        }
        let dirPath = `${DATAPATH}/files/${pId}/`;
        // read all files in the directory
        let files = [];
        try {
          files = await fsp.readdir(dirPath);
        } catch (err) {
          console.error("Error reading directory", dirPath, err);
          await fsp.mkdir(dirPath);
        }
        // read each file and return the contents
        let data = await Promise.all(
          files.map(async (f) => {
            let fullPath = dirPath + f;
            let contents = await fsp.readFile(fullPath, "utf8");
            try {
              contents = JSON.parse(contents);
            } catch (err) {
              console.error("Error parsing file", fullPath, err);
              contents = {};
            }
            // strip the file extension
            return { id: f.split(".")[0], ...contents };
          }),
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } else if (req.method == "POST" || req.method == "PUT") {
        // save a file
        let query = parsedUrl.searchParams;
        let pId = query.get("pId");
        let body = await getBody(req);
        let bodyObject = JSON.parse(body);
        let fileId = bodyObject.id;
        let fullPath = `${DATAPATH}/files/${pId}/${fileId}.json`;
        await fsp.writeFile(fullPath, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: true }));
      }
      break;
    default:
      // remove any path elements that go "up" in the file hierarchy
      let safePath = path
        .split("/")
        .filter((e) => !e.startsWith("."))
        .join("/");

      if (
        safePath === "/" &&
        PUBLIC &&
        !req.headers.host?.startsWith(PUBLIC_HOSTNAME)
      ) {
        safePath = "/about.html";
      } else if (safePath === "/" || safePath.startsWith("/collect/")) {
        safePath = "/index.html";
      }
      // try to get the requested file.
      try {
        let fullPath = "build" + safePath;
        if ((await fsp.stat(fullPath)).isFile()) {
          // if it's a valid file, then serve it! The mime library uses the
          // file extension to figure out the "mimetype" of the file.
          res.writeHead(200, { "Content-Type": mime.getType(safePath) });

          // create a "read stream" and "pipe" (connect) it to the response.
          // this sends all the data from the file to the client.
          fs.createReadStream(fullPath).pipe(res);
        } else {
          // if it's not a valid file, return a "404 not found" error.
          console.log("unknown request", path);
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end("Couldn't find your URL...");
        }
      } catch (err) {
        // if there's an error reading the file, return a
        // "500 internal server error" error
        console.log("Error reading static file?", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("Failed to load something...try again later?");
      }
      break;
  }
});
// tell the module to listen on the port we chose.
server.listen(PORT);

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

/******************
 *                *
 *    The API     *
 *                *
 ******************/
let openai = {
  api: new OpenAIApi(new Configuration({ apiKey: OPEN_AI_KEY })),
  cache: new LRUCache({
    // NB: cache is not saved across restarts
    max: 1000,
  }),
};

let api = {
  async getHistory(name) {
    name = name.replace(/[^a-zA-Z0-9-_]/g, "");
    // get a history entry by name
    let fullPath = `${DATAPATH}/history/${name}.json`;
    let data = await fsp.readFile(fullPath, "utf8");
    return JSON.parse(data);
  },
  async allHistory() {
    // list all the templates
    let list = await fsp.readdir(`${DATAPATH}/history`);
    let names = list
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
    // if (! includeData) {
    //   return names;
    // }
    return await Promise.all(names.map((name) => this.getHistory(name)));
  },
  seed: Math.round(Math.random() * 1000000000),
  async saveHistory(time, data) {
    const seed = String(this.seed++);
    if (seed > 1000000000) {
      this.seed = 0;
    }
    const clean = (s) => String(s).replace(/[^a-zA-Z0-9-_]/g, "");
    let name = `h-${clean(data.sessionId)}-${clean(time)}-${seed}`;
    data.id = name;
    // save a conversation by name
    let fullPath = `${DATAPATH}/history/${name}.json`;
    await fsp.writeFile(fullPath, JSON.stringify(data, null, 2));
    return name;
  },
};

// all ready! print the port we're listening on to make connecting easier.
console.log("Listening on port", PORT);
