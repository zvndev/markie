// Separate, opt-in lane. Never infer a private release from the public config.
module.exports = async () => {
  const { createPrivateBuilderConfig } = await import("./scripts/private-release.mjs");
  return createPrivateBuilderConfig(process.env, __dirname);
};
