const fs = require("fs");
const path = require("path");
const solc = require("solc");

const source = fs.readFileSync(path.join(__dirname, "PharmaChain.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: {
    "PharmaChain.sol": { content: source }
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const fatal = output.errors.filter(e => e.severity === "error");
  output.errors.forEach(e => console.error(e.formattedMessage));
  if (fatal.length) process.exit(1);
}

const contract = output.contracts["PharmaChain.sol"]["PharmaChain"];
const abi = contract.abi;
const bytecode = "0x" + contract.evm.bytecode.object;
const deployedBytecode = "0x" + contract.evm.deployedBytecode.object;

fs.writeFileSync(
  path.join(__dirname, "compiled.json"),
  JSON.stringify({ abi, bytecode, deployedBytecode }, null, 2)
);

console.log("Compiled OK.");
console.log("ABI entries:", abi.length);
console.log("Bytecode length (chars):", bytecode.length);