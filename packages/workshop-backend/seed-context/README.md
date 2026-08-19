# Seeded context collections

Sample context a fresh deployment ships with, so the guided first build (OZL-311) has something
real for the agent to read. Without it a new user lands in an empty product and the walkthrough has
nothing to walk them through.

Committed **as data**, mirroring `../format-blueprints/`: the deployment installs these into the
Context Library on first use, after which they are ordinary public collections that an admin can
edit or delete.

## Layout

One directory per collection:

```
seed-context/
  acme-field-report/
    collection.json     what a human curates: title, description, icon, collectionKey
    *.md                the documents, one file per document
```

`collection.json` carries the curated metadata; each `.md` file becomes one document whose path is
its filename. The first line of the file is used as the document description, so it should read as
a one-line summary rather than a heading.

## Replacing this for your own deployment

Point `SEED_CONTEXT_DIR` at your own directory. A customer demonstrating their own data should not
have to edit this repo — same reasoning as `FORMAT_BLUEPRINTS_DIR`.

The sample here is deliberately generic and obviously fictional. It exists to demonstrate the
mechanism, not to be useful: real deployments replace it.

## Why public rather than private

`createContextCollection(…, "public")` requires admin and makes the collection readable by everyone
and auto-enabled (`gatekeeper-context/src/context-api.ts:191`). That is what lets a *new* user see
seeded context on their first visit without anyone provisioning it for them — a private collection
would be owned by whoever happened to install it and invisible to everyone else.

## Idempotence

Installation is keyed on `collectionKey`, not on the title, and stamped with a content-derived
manifest version. Re-running installs nothing when the content has not changed, and updates in
place when it has — it never creates a second copy. Renaming a collection in `collection.json` is
therefore safe; changing its `collectionKey` orphans the old one, exactly as `blueprintId` does.
