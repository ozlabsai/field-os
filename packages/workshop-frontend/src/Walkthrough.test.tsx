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

// Every anchor the story points at, in order.
const ALL = [
  "home-composer",
  "nav-outputs",
  "nav-gatekeepers-context",
  "nav-gatekeepers",
];

const selector = (id: string) => `[data-tour="${id}"]`;

// Render a page containing exactly the given `data-tour` anchors, standing in for whichever of
// them a deployment actually shows.
function renderAnchors(tourIds: string[]) {
  document.body.innerHTML = tourIds
    .map((id) => `<a data-tour="${id}">anchor</a>`)
    .join("");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("presentSteps", () => {
  it("keeps every step, in story order, when the deployment renders them all", () => {
    renderAnchors(ALL);
    expect(presentSteps().map((s) => s.element)).toEqual(ALL.map(selector));
  });

  it("drops steps whose anchor this deployment does not render", () => {
    // A deployment with no Context Library gatekeeper and connectors disabled.
    renderAnchors(["home-composer", "nav-outputs"]);
    const steps = presentSteps();
    expect(steps.map((s) => s.element)).toEqual(
      ["home-composer", "nav-outputs"].map(selector),
    );
    // The point of the filter: nothing points at an element that is not there.
    for (const step of steps) {
      expect(document.querySelector(step.element as string)).not.toBeNull();
    }
  });

  it("returns nothing when no anchor is present, so the tour can decline to run", () => {
    renderAnchors([]);
    expect(presentSteps()).toHaveLength(0);
  });

  it("gives the composer step no way to click past it", () => {
    renderAnchors(ALL);
    const [composer] = presentSteps();
    // Only 'close'. A Next here would let someone finish the tour without ever asking for
    // anything, which is the one action the whole story is built on.
    expect(composer.popover?.showButtons).toEqual(["close"]);
    expect(composer.popover?.showButtons).not.toContain("next");
  });

  it("gives the later steps ordinary navigation", () => {
    renderAnchors(ALL);
    const [, outputs] = presentSteps();
    expect(outputs.popover?.showButtons).toContain("next");
    expect(outputs.popover?.showButtons).toContain("previous");
  });

  it("carries the popover copy for each surviving step", () => {
    renderAnchors(["home-composer"]);
    const [step] = presentSteps();
    expect(step.popover?.title).toBe("Ask for something real");
    expect(step.popover?.description).toContain("site-visit");
  });
});

// The nav steps are declared against `data-tour` values that SidebarItem *derives* from each row's
// route. Asserting the two halves separately would let them drift: a change to the derivation
// would leave the filter tests green while every nav step silently stopped matching. This mounts
// the real SidebarItem and runs the real presentSteps() against what it rendered.
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

  it("matches the nav steps the real rows emit", async () => {
    await renderRows(["/outputs", "/gatekeepers/context", "/gatekeepers"]);
    // The contract under test: what SidebarItem emits is what STEPS declares. The composer step
    // is absent here because no composer is rendered, which is the filter doing its job.
    expect(presentSteps().map((s) => s.element)).toEqual(
      ["nav-outputs", "nav-gatekeepers-context", "nav-gatekeepers"].map(selector),
    );
  });

  it("drops the nav steps whose real rows this deployment does not render", async () => {
    await renderRows(["/outputs"]);
    expect(presentSteps().map((s) => s.element)).toEqual([selector("nav-outputs")]);
  });
});
