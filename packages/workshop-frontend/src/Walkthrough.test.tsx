// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { presentSteps } from "./Walkthrough";

// Render a rail containing exactly the given `data-tour` rows, standing in for whichever nav items
// a deployment actually shows.
function renderRail(tourIds: string[]) {
  document.body.innerHTML = tourIds
    .map((id) => `<a data-tour="${id}">row</a>`)
    .join("");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("presentSteps", () => {
  it("keeps every step when the deployment renders the whole rail", () => {
    renderRail([
      "nav-home",
      "nav-workspaces",
      "nav-blueprints",
      "nav-outputs",
      "nav-gatekeepers",
    ]);
    const steps = presentSteps();
    expect(steps).toHaveLength(5);
    // Declaration order is the tour's order, and must survive filtering.
    expect(steps.map((s) => s.element)).toEqual([
      '[data-tour="nav-home"]',
      '[data-tour="nav-workspaces"]',
      '[data-tour="nav-blueprints"]',
      '[data-tour="nav-outputs"]',
      '[data-tour="nav-gatekeepers"]',
    ]);
  });

  it("drops steps whose target this deployment does not render", () => {
    // A deployment with connectors disabled and no blueprints surface.
    renderRail(["nav-home", "nav-workspaces", "nav-outputs"]);
    const steps = presentSteps();
    expect(steps.map((s) => s.element)).toEqual([
      '[data-tour="nav-home"]',
      '[data-tour="nav-workspaces"]',
      '[data-tour="nav-outputs"]',
    ]);
    // The point of the filter: nothing points at an element that is not there.
    for (const step of steps) {
      expect(document.querySelector(step.element as string)).not.toBeNull();
    }
  });

  it("returns nothing when the rail is absent, so the tour can decline to run", () => {
    renderRail([]);
    expect(presentSteps()).toHaveLength(0);
  });

  it("carries the popover copy for each surviving step", () => {
    renderRail(["nav-home"]);
    const [step] = presentSteps();
    expect(step.popover?.title).toBe("Start here");
    expect(step.popover?.description).toContain("launcher");
  });
});
