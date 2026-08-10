// Trivial handler -- these fixtures exist only to prove workerd accepts or rejects a given
// compatibilityFlags list at boot, before any request is ever sent.

export default {
  async fetch() {
    return new Response("ok");
  },
};
