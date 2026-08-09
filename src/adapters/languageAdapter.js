class LanguageAdapter {
  canHandle() {
    return false;
  }

  createSession() {
    throw new Error("createSession must be implemented by a language adapter.");
  }
}

module.exports = {
  LanguageAdapter
};

