import { describe, expect, it } from "vitest";
import {
  generalAccessFor,
  generalAccessLabel,
  generalAccessLine,
  memberStatusLine,
  publishWarning,
  revokeWarning,
  roleDescription,
} from "./general-access";

describe("what the world can do", () => {
  it("is restricted until a public link exists", () => {
    expect(generalAccessFor(null)).toBe("restricted");
    expect(generalAccessFor("https://markiedocs.com/s/abc")).toBe("link");
  });

  it("names the two states the way the owner will read them", () => {
    expect(generalAccessLabel("restricted")).toBe("Restricted");
    expect(generalAccessLabel("link")).toBe("Anyone with the link");
  });
});

describe("the line that says who can open this", () => {
  // The sentence that was missing. Its absence is the whole reason two
  // documents were public for two months without anyone noticing.
  it("says plainly when the document is public", () => {
    const line = generalAccessLine({ general: "link", namedCount: 1, invitedCount: 0 });
    expect(line).toContain("Anyone on the internet");
    expect(line).toContain("without signing in");
  });

  it("says only you when nobody has been added", () => {
    expect(
      generalAccessLine({ general: "restricted", namedCount: 0, invitedCount: 0 })
    ).toBe("Only you can open this document.");
  });

  it("counts the people who have joined", () => {
    expect(
      generalAccessLine({ general: "restricted", namedCount: 1, invitedCount: 0 })
    ).toBe("Only you and 1 person can open this document.");
    expect(
      generalAccessLine({ general: "restricted", namedCount: 3, invitedCount: 0 })
    ).toBe("Only you and 3 people can open this document.");
  });

  // Counted separately because they are not the same thing: an invited person
  // has no access at all until they make an account.
  it("keeps invited people separate from joined people", () => {
    expect(
      generalAccessLine({ general: "restricted", namedCount: 2, invitedCount: 1 })
    ).toBe("Only you and 2 people and 1 invited can open this document.");
    expect(
      generalAccessLine({ general: "restricted", namedCount: 0, invitedCount: 2 })
    ).toBe("Only you and 2 invited can open this document.");
  });

  // Being public outranks everything else on the screen: if the link is live,
  // the count of named people is not the answer to "who can see this".
  it("reports public even when people are also named", () => {
    expect(
      generalAccessLine({ general: "link", namedCount: 5, invitedCount: 2 })
    ).toContain("Anyone on the internet");
  });
});

describe("what the owner is told before acting", () => {
  it("warns that publishing cannot be taken back", () => {
    const warning = publishWarning("biovara-claims-audit.md");
    expect(warning).toContain("biovara-claims-audit.md");
    expect(warning).toContain("without an account");
    expect(warning).toContain("not un-see it");
  });

  it("warns that revoking breaks links other people hold", () => {
    expect(revokeWarning()).toContain("stops working immediately");
  });
});

describe("roles say what they permit", () => {
  it("distinguishes editing from sharing", () => {
    expect(roleDescription("owner")).toBe("Can edit, share, and delete");
    expect(roleDescription("editor")).toBe("Can edit, but not share");
    expect(roleDescription("viewer")).toBe("Can read, but not edit");
  });

  it("marks someone who has not joined", () => {
    expect(memberStatusLine(false)).toBe("Invited, not joined yet");
    expect(memberStatusLine(true)).toBe("");
  });
});
