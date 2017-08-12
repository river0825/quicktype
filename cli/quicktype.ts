#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as process from "process";

const Main = (() => {
  try {
    return require("../output/Main");
  } catch (e) {
    return require("./bundle");    
  }
})();

const makeSource = require("stream-json");
const Assembler  = require("stream-json/utils/Assembler");
const commandLineArgs = require('command-line-args')
const getUsage = require('command-line-usage')
const fetch = require("node-fetch");
const chalk = require("chalk");

const langs = Main.renderers.map((r) => r.extension).join("|");
const langNames = Main.renderers.map((r) => r.name).join(", ");

const optionDefinitions = [
  {
    name: 'out',
    alias: 'o',
    type: String,
    typeLabel: `FILE`,
    description: 'The output file. Determines --lang and --top-level.'
  },
  {
    name: 'top-level',
    alias: 't',
    type: String,
    typeLabel: 'NAME',
    description: 'The name for the top level type.'
  },
  {
    name: 'lang',
    alias: 'l',
    type: String,
    typeLabel: langs,
    description: 'The target language.'
  },
  {
    name: 'src-lang',
    alias: 's',
    type: String,
    defaultValue: 'json',
    typeLabel: 'json|schema',
    description: 'The source language (default is json).'
  },
  {
    name: 'src',
    type: String,
    multiple: true,
    defaultOption: true,
    typeLabel: 'FILE|URL',
    description: 'The file or url to type.'
  },
  {
    name: 'urls-from',
    type: String,
    typeLabel: '[underline]{file}',
    description: 'Tracery grammar describing URLs to crawl.'
  },
  {
    name: 'help',
    alias: 'h',
    type: Boolean,
    description: 'Get some help.'
  }
];

const sections = [
  {
    header: 'Synopsis',
    content: `$ quicktype [[bold]{--lang} ${langs}] FILE|URL ...`
  },
  {
    header: 'Description',
    content: `Given JSON sample data, quicktype outputs code for working with that data in ${langNames}.`
  },
  {
    header: 'Options',
    optionList: optionDefinitions
  },
  {
    header: 'Examples',
    content: [
      chalk.dim('Generate C# to parse a Bitcoin API'),
      '$ quicktype -o LatestBlock.cs https://blockchain.info/latestblock',
      '',
      chalk.dim('Generate Go code from a JSON file'),
      '$ quicktype -l go user.json',
      '',
      chalk.dim('Generate JSON Schema, then TypeScript'),
      '$ quicktype -o schema.json https://blockchain.info/latestblock',
      '$ quicktype -o bitcoin.ts --src-lang schema schema.json'
    ]
  },
  {
    content: 'Learn more at [bold]{quicktype.io}'
  }
];

const options = commandLineArgs(optionDefinitions);

function getRenderer() {
  let renderer = Main.renderers.find((r) => {
    return [r.extension, r.aceMode, r.name].indexOf(options.lang) !== -1;
  });

  if (!renderer) {
    console.error(`'${options.lang}' is not yet supported as an output language.`);
    process.exit(1);
  }

  return renderer;
}

function fromRight(either) {
  let { constructor: { name }, value0: result } = either;
  if (name == "Left") {
    console.error(result);
    process.exit(1);
  } else {
    return result;
  }
}

interface JsonArrayMap {
  [key: string]: object[];
}

function renderFromJsonArrayMap(jsonArrayMap: JsonArrayMap) {
    let pipeline = {
      "json": Main.renderFromJsonArrayMap,
      "schema": Main.renderFromJsonSchemaArrayMap
    }[options["src-lang"]];
 
    if (!pipeline) {
      console.error(`Input language '${options["src-lang"]}' is not supported.`);
      process.exit(1);
    }

    let input = {
      input: jsonArrayMap,
      renderer: getRenderer()
    };
    
    return fromRight(pipeline(input));    
}

function renderAndOutput(jsonArrayMap: JsonArrayMap) {
  let output = renderFromJsonArrayMap(jsonArrayMap);
  if (options.out) {
    fs.writeFileSync(options.out, output); 
  } else {
    process.stdout.write(output);
  }
}

function workFromJsonArray(jsonArray: object[]) {
  let jsonArrayMap = {};
  jsonArrayMap[options["top-level"]] = jsonArray;
  renderAndOutput(jsonArrayMap);
}

function parseJsonFromStream(
  stream: fs.ReadStream | NodeJS.Socket,
  continueWithJson: Continue<object>) {

  let source = makeSource();
  let assembler = new Assembler();

  source.output.on("data", chunk => {
    assembler[chunk.name] && assembler[chunk.name](chunk.value);
  });

  source.output.on("end", () => {
    continueWithJson(assembler.current);
  });

  stream.setEncoding('utf8');
  stream.pipe(source.input);
  stream.resume();
}

function usage() {
  console.log(getUsage(sections));
}

type Continue<T> = (t: T) => void;

function mapArrayC<T, U>(
  array: T[],
  f: (t: T, cont: Continue<U>) => void,
  continuation: Continue<U[]>) {
    
  if (array.length == 0) {
    return continuation([]);
  }

  f(array[0], first => {
    mapArrayC(array.slice(1), f, rest => continuation([first].concat(rest)));
  });
}

function mapObjectValuesC(
  obj: object,
  f: (t: any, cont: Continue<any>) => void,
  continuation: Continue<any>) {

  let keys = Object.keys(obj);
  let resultObject = {};

  mapArrayC(keys, (key, arrayContinuation) => {
    let value = obj[key];
    f(value, newValue => {
      resultObject[key] = newValue;
      arrayContinuation(null);
    });
  }, () => {
    continuation(resultObject);
  });
}

function parseFileOrUrl(fileOrUrl: string, continueWithJson: Continue<object>) {
  if (fs.existsSync(fileOrUrl)) {
    parseJsonFromStream(fs.createReadStream(fileOrUrl), continueWithJson);
  } else {
    fetch(fileOrUrl).then(res => parseJsonFromStream(res.body, continueWithJson));
  }
}

function parseFileOrUrlArray(filesOrUrls: string[], continuation) {
  mapArrayC(filesOrUrls, parseFileOrUrl, continuation);
}

function inferLang(): string {
  // Output file extension determines the language if language is undefined
  if (options.out) {
    let extension = path.extname(options.out);
    if (extension == "") {
      console.error("Please specify a language (--lang) or an output file extension.");
      process.exit(1);
    }
    return extension.substr(1);
  }

  return "go";
}

function inferTopLevel(): string {
  // Output file name determines the top-level if undefined
  if (options.out) {
    let extension = path.extname(options.out);
    let without = path.basename(options.out).replace(extension, "");
    return without;
  }

  // Source determines the top-level if undefined
  if (options.src.length == 1) {
    let src = options.src[0];
    let extension = path.extname(src);
    let without = path.basename(src).replace(extension, "");
    return without;
  }

  return "TopLevel";
}

function main(args: string[]) {
  options["lang"] = options["lang"] || inferLang();
  options["top-level"] = options["top-level"] || inferTopLevel();
  options.src = options.src || [];

  if (args.length == 0 || options.help) {
    usage();
  } else if (options["urls-from"]) {
    let json = JSON.parse(fs.readFileSync(options["urls-from"], "utf8"));
    let jsonArrayMapOrError = Main.urlsFromJsonGrammar(json);
    let result = jsonArrayMapOrError.value0;
    if (typeof result == 'string') {
      console.error("Error: " + result);
      process.exit(1);
    } else {
      mapObjectValuesC(result, parseFileOrUrlArray, renderAndOutput);
    }
  } else if (options.src.length == 0) {
    parseJsonFromStream(process.stdin, json => workFromJsonArray([json]));
  } else if (options.src.length == 1) {
    parseFileOrUrlArray(options.src, workFromJsonArray);
  } else {
    usage();
    process.exit(1);
  }
}

main(process.argv.slice(2));
