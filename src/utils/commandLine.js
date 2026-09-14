function parseCommandLine(commandLine, fallbackCommand) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match = pattern.exec(commandLine || "");

  while (match) {
    tokens.push(match[1] || match[2] || match[0]);
    match = pattern.exec(commandLine || "");
  }

  if (tokens.length > 0) {
    return tokens;
  }

  return [fallbackCommand];
}

module.exports = {
  parseCommandLine
};