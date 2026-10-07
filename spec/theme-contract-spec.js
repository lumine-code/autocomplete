const path = require("path");

describe("completion type badge theme ownership", () => {
  let stylesheet;
  let host;
  let icon;

  beforeEach(() => {
    stylesheet = lumine.themes.requireStylesheet(path.join(__dirname, "..", "styles", "main.css"));
    host = document.createElement("div");
    host.className = "theme-one-day-ui";
    host.innerHTML =
      '<autocomplete-suggestion-list class="select-list popover-list"><ol class="list-group"><li><span class="icon-container"><i class="icon class"><span class="icon-letter">C</span></i></span></li></ol></autocomplete-suggestion-list>';
    icon = host.querySelector(".icon");
    jasmine.attachToDOM(host);
  });

  afterEach(() => {
    host.remove();
    stylesheet.dispose();
  });

  function backgroundPixel() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = getComputedStyle(icon).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  }

  it("keeps a pale syntax glyph on an opaque syntax badge under a light UI theme", () => {
    host.style.cssText =
      "--overlay-background-color: rgb(250,250,250); --syntax-background-color: rgb(10,20,30); --syntax-color-class: rgb(220,230,240);";
    expect(getComputedStyle(icon).color).toBe("rgb(220, 230, 240)");
    const backing = backgroundPixel();
    expect(backing[3]).toBe(255);
    expect(backing[0]).toBeLessThan(100);
    expect(backing[1]).toBeLessThan(100);
    expect(backing[2]).toBeLessThan(100);
    host.style.setProperty("--overlay-background-color", "rgb(100,110,120)");
    expect(backgroundPixel()).toEqual(backing);
  });

  it("follows the syntax foreground and background under the opposite UI pair", () => {
    host.className = "theme-one-night-ui";
    host.style.cssText =
      "--overlay-background-color: rgb(10,20,30); --syntax-background-color: rgb(240,245,250); --syntax-color-class: rgb(20,30,40);";
    expect(getComputedStyle(icon).color).toBe("rgb(20, 30, 40)");
    const backing = backgroundPixel();
    expect(backing[3]).toBe(255);
    expect(backing[0]).toBeGreaterThan(190);
    expect(backing[1]).toBeGreaterThan(190);
    expect(backing[2]).toBeGreaterThan(190);
    host.style.setProperty("--syntax-color-class", "rgb(40,180,90)");
    expect(getComputedStyle(icon).color).toBe("rgb(40, 180, 90)");
    expect(backgroundPixel()).not.toEqual(backing);
    const recolored = backgroundPixel();
    host.style.setProperty("--syntax-background-color", "rgb(200,210,220)");
    expect(backgroundPixel()).not.toEqual(recolored);
  });
});
