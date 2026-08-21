import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "@/store/ui";

import EmailBlur from "./EmailBlur";

describe("EmailBlur", () => {
  beforeEach(() => {
    useUi.getState().setTheoMod(false);
  });

  it("renders the text untouched when TheoMod is off", () => {
    const { container } = render(<EmailBlur text="me@example.com" />);
    expect(container.textContent).toBe("me@example.com");
    expect(container.querySelector(".blur-\\[3px\\]")).toBeNull();
  });

  it("keeps the real email in the DOM while blurred", () => {
    useUi.getState().setTheoMod(true);
    render(<EmailBlur text="me@example.com" />);
    const blurred = document.querySelector(".blur-\\[3px\\]");
    expect(blurred).not.toBeNull();
    expect(blurred?.textContent).toBe("me@example.com");
  });

  it("blurs only email-shaped segments of a mixed string", () => {
    useUi.getState().setTheoMod(true);
    const { container } = render(<EmailBlur text="me@example.com · max" />);
    const blurSpans = container.querySelectorAll(".blur-\\[3px\\]");
    expect(blurSpans).toHaveLength(1);
    expect(blurSpans[0]?.textContent).toBe("me@example.com");
    expect(container.textContent).toBe("me@example.com · max");
  });

  it("blurs every email when several appear", () => {
    useUi.getState().setTheoMod(true);
    const { container } = render(<EmailBlur text="first@example.com then second@test.org" />);
    const blurSpans = container.querySelectorAll(".blur-\\[3px\\]");
    expect(blurSpans).toHaveLength(2);
    expect(blurSpans[0]?.textContent).toBe("first@example.com");
    expect(blurSpans[1]?.textContent).toBe("second@test.org");
  });

  it("leaves strings with no email alone", () => {
    useUi.getState().setTheoMod(true);
    render(<EmailBlur text="just a label" />);
    expect(document.querySelector(".blur-\\[3px\\]")).toBeNull();
    expect(screen.getByText("just a label")).toBeInTheDocument();
  });
});
