export class XML {
  static stringify({ name, attributes, value }: { name: string; attributes: string; value: any }): string {
    function buildRequest(el: Element, params: any) {
      if (params === null) {
        el.setAttribute("xsi:nil", "true");
      } else if (typeof params === "object") {
        for (const [key, val] of Object.entries(params)) {
          if (key === "_") {
            if (val === null) {
              el.setAttribute("xsi:nil", "true");
            } else {
              el.textContent = String(val);
            }
          } else if (key === "$xsi:type") {
            el.setAttribute("xsi:type", val as string);
          } else if (val === undefined) {
            // ignore
          } else if (Array.isArray(val)) {
            for (const element of val) {
              const x = doc.createElement(key);
              buildRequest(x, element);
              el.appendChild(x);
            }
          } else {
            const x = doc.createElement(key);
            buildRequest(x, val);
            el.appendChild(x);
          }
        }
      } else {
        el.textContent = String(params);
      }
    }
    const doc = new DOMParser().parseFromString("<" + name + attributes + "/>", "text/xml");
    buildRequest(doc.documentElement, value);
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(doc).replace(/ xmlns=""/g, "");
  }

  static parse(element: Element): any {
    function parseResponse(el: Element): any {
      let str = ""; // XSD Simple Type value
      let obj: any = null; // XSD Complex Type value
      // If the element has child elements, it is a complex type. Otherwise we assume it is a simple type.
      if (el.getAttribute("xsi:nil") === "true") {
        return null;
      }
      const type = el.getAttribute("xsi:type");
      if (type) {
        // Salesforce never sets the xsi:type attribute on simple types. It is only used on sObjects.
        obj = {
          "$xsi:type": type
        };
      }
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        if (child instanceof CharacterData) {
          str += child.data;
        } else if (child instanceof Element) {
          if (obj === null) {
            obj = {};
          }
          const name = child.localName;
          const content = parseResponse(child);
          if (name in obj) {
            if (Array.isArray(obj[name])) {
              obj[name].push(content);
            } else {
              obj[name] = [obj[name], content];
            }
          } else {
            obj[name] = content;
          }
        }
      }
      return obj || str;
    }
    return parseResponse(element);
  }
}
