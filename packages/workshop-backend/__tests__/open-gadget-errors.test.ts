import { describe, expect, it } from "vitest";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it.each([
    [OPEN_GADGET_ERROR_CODES.workspaceNotFound, "Workspace not found."],
    [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied, "You don't have access to this workspace."],
    [OPEN_GADGET_ERROR_CODES.crossOrgAccessDenied, "You don't have access to this workspace."],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenGadgetError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenGadgetErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_GADGET_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenGadgetErrorCode(new Error(code))).toBeUndefined();
    },
  );

  // The org boundary's whole design rests on these two properties holding together (OZL-216).
  it("makes an org denial indistinguishable to the caller but distinguishable to the server", () => {
    let denied = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    let crossOrg = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.crossOrgAccessDenied);

    // Identical wording, so being refused by the org boundary does not tell the person refused
    // that some other org holds a workspace at this id.
    expect(crossOrg.message).toBe(denied.message);

    // Distinct codes, so `#openGadgetInternal` can keep the caller's workspace listing on an org
    // denial while still dropping it on a genuine loss of access. Without this, enabling
    // ENABLE_ORG_SEPARATION would irreversibly purge those listings and the flag would stop being
    // reversible -- which is the entire reason this code exists separately.
    expect(getOpenGadgetErrorCode(crossOrg))
        .not.toBe(getOpenGadgetErrorCode(denied));
  });

  it("does not classify unexpected errors", () => {
    expect(getOpenGadgetErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenGadgetErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
