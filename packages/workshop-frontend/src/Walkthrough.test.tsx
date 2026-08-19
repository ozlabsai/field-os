// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";

import SidebarItem, {
  type SidebarItemProps,
} from "./components/AppShell/SidebarItem";
import { presentSteps } from "./Walkthrough";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

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

// The steps above are declared against `data-tour` values that SidebarItem *derives* from each
// row's route. Asserting the two halves separately would let them drift: a change to the derivation
// would leave the filter test green while every step silently stopped matching. This mounts the
// real SidebarItem and runs the real presentSteps() against what it rendered.
describe("presentSteps against the real SidebarItem", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  // Render the given routes as real sidebar rows, through a real router so SidebarItem's
  // pathname-driven active state resolves. Async: the router resolves its initial match on a
  // microtask, and a synchronous act() returns before anything is in the DOM.
  async function renderRows(paths: string[]) {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          {paths.map((path) => (
            <SidebarItem
              key={path}
              // The generated route-tree union is stricter than a parameterised test needs;
              // SidebarItem itself loosens `to` the same way internally.
              to={path as SidebarItemProps["to"]}
              label={path}
              icon={null}
            />
          ))}
          <Outlet />
        </>
      ),
    });
    const children = paths.map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    );
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren(children),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<RouterProvider router={router as never} />);
    });
  }

  it("matches every step when the real rows for them are rendered", async () => {
    await renderRows(["/", "/workspaces", "/blueprints", "/outputs", "/gatekeepers"]);
    // The contract under test: what SidebarItem emits is what STEPS declares.
    expect(presentSteps().map((s) => s.element)).toEqual([
      '[data-tour="nav-home"]',
      '[data-tour="nav-workspaces"]',
      '[data-tour="nav-blueprints"]',
      '[data-tour="nav-outputs"]',
      '[data-tour="nav-gatekeepers"]',
    ]);
  });

  it("drops the steps whose real rows this deployment does not render", async () => {
    await renderRows(["/", "/workspaces"]);
    expect(presentSteps().map((s) => s.element)).toEqual([
      '[data-tour="nav-home"]',
      '[data-tour="nav-workspaces"]',
    ]);
  });
});
