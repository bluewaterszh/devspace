import assert from "node:assert/strict";
import test from "node:test";
import { selectSsoAction } from "../lib/control-plane.mjs";

function candidate(label, kind = "button") {
  return {
    label,
    kind,
    frameUrl: "https://sso.example.test/",
    locator: { label },
  };
}

test("prefers the exact enterprise risk acceptance action", () => {
  const risk = candidate("接受风险并访问");
  const cancel = candidate("取消");
  assert.equal(
    selectSsoAction([cancel, risk], { allowSingleFallback: true }),
    risk,
  );
});

test("selects common positive SSO actions", () => {
  for (const label of ["继续", "允许", "授权", "登录", "Continue", "Approve", "Sign in"]) {
    const action = candidate(label);
    assert.equal(selectSsoAction([action]), action, label);
  }
});

test("never selects explicit negative SSO actions", () => {
  for (const label of ["取消", "拒绝", "返回", "Cancel", "Deny", "Back"]) {
    assert.equal(
      selectSsoAction([candidate(label)], { allowSingleFallback: true }),
      undefined,
      label,
    );
  }
});

test("single fallback only applies to one non-negative submit action", () => {
  const submit = candidate("Go", "input:submit");
  assert.equal(
    selectSsoAction([submit], { allowSingleFallback: true }),
    submit,
  );

  assert.equal(
    selectSsoAction(
      [candidate("One"), candidate("Two")],
      { allowSingleFallback: true },
    ),
    undefined,
  );
});
