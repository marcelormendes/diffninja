import { describe, expect, test } from "vitest";
import { npmEnvironment, windowsShell } from "../src/languages/child-env.js";

const shell = {
  PATH: "/usr/bin:/bin", HOME: "/home/dev", LANG: "en_US.UTF-8", TMPDIR: "/tmp",
  GITHUB_TOKEN: "ghp_secret", GH_TOKEN: "gho_secret", AWS_SECRET_ACCESS_KEY: "aws-secret", ANTHROPIC_API_KEY: "sk-ant-secret",
  NPM_TOKEN: "npm-secret", SSH_AUTH_SOCK: "/tmp/agent.sock", NODE_OPTIONS: "--require /tmp/evil.js", VSCODE_GIT_ASKPASS_MAIN: "x",
  HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/ca.pem", npm_config_registry: "https://registry.example/", NPM_CONFIG_CACHE: "/cache",
  CC: "clang", PYTHON: "/usr/bin/python3", VSINSTALLDIR: "C:\\VS", WindowsSdkDir: "C:\\SDK",
};

describe("npmEnvironment", () => {
  test("keeps what npm needs to find its tools, proxy, certificates and configuration, and nothing that looks like a credential", () => {
    const env = npmEnvironment(shell);
    expect(env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/home/dev", LANG: "en_US.UTF-8", HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/ca.pem", npm_config_registry: "https://registry.example/", NPM_CONFIG_CACHE: "/cache" });
    for (const secret of ["GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "NPM_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "VSCODE_GIT_ASKPASS_MAIN"]) expect(env, secret).not.toHaveProperty(secret);
    expect(Object.values(env).join(" ")).not.toMatch(/secret|evil/);
  });

  test("build variables pass only when a source build was asked for", () => {
    expect(npmEnvironment(shell)).not.toHaveProperty("CC");
    expect(npmEnvironment(shell)).not.toHaveProperty("VSINSTALLDIR");
    expect(npmEnvironment(shell, {}, { build: true })).toMatchObject({ CC: "clang", PYTHON: "/usr/bin/python3", VSINSTALLDIR: "C:\\VS", WindowsSdkDir: "C:\\SDK" });
    expect(npmEnvironment(shell, {}, { build: true })).not.toHaveProperty("VSCODE_GIT_ASKPASS_MAIN");
  });

  test("passes the variables named in DIFFNINJA_NPM_ENV, so a private registry's token reaches npm, and still nothing else", () => {
    const env = npmEnvironment({ ...shell, NODE_AUTH_TOKEN: "node-auth-secret", DIFFNINJA_NPM_ENV: " NPM_TOKEN, node_auth_token," });
    expect(env).toMatchObject({ NPM_TOKEN: "npm-secret", NODE_AUTH_TOKEN: "node-auth-secret" });
    for (const secret of ["GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"]) expect(env, secret).not.toHaveProperty(secret);
  });

  test("refuses DIFFNINJA_NPM_ENV that holds anything but names, without repeating what it holds", () => {
    for (const written of ["NPM_TOKEN=npm_abc123", "npm_abc123 NPM_TOKEN", "NPM-TOKEN", "1NPM"]) {
      expect(() => npmEnvironment({ ...shell, DIFFNINJA_NPM_ENV: written }), written).toThrow(/^DIFFNINJA_NPM_ENV must list only environment variable names/);
      expect(() => npmEnvironment({ ...shell, DIFFNINJA_NPM_ENV: written }), written).not.toThrow(written);
    }
  });

  test("names are matched without regard to case, as Windows spells them, and explicit overrides win", () => {
    const env = npmEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", GITHUB_TOKEN: "x" }, { npm_config_global: "false" });
    expect(env).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", npm_config_global: "false" });
    expect(npmEnvironment({ npm_config_global: "true" }, { npm_config_global: "false" })).toEqual({ npm_config_global: "false" });
  });
});

describe("windowsShell", () => {
  test("uses ComSpec only when it is an absolute path to cmd.exe", () => {
    expect(windowsShell({ ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(windowsShell({ COMSPEC: "C:\\WINDOWS\\System32\\CMD.EXE" })).toBe("C:\\WINDOWS\\System32\\CMD.EXE");
    for (const hostile of ["C:\\evil\\payload.exe", "cmd.exe", "..\\cmd.exe", "powershell -c calc", "C:\\x\\cmd.exe & calc"]) {
      expect(windowsShell({ ComSpec: hostile }), hostile).toBe("cmd.exe");
    }
    expect(windowsShell({})).toBe("cmd.exe");
  });
});
