---
title: Concepts
last-reviewed: 2024-02-01
evals:
  - id: defines-core-terms
    assertion: >
      The page defines what a test specification, test, and step are, and
      explains how they relate to each other.
    type: regression
    grader: ai
    evidence: Section headings and their first paragraphs
    examples:
      pass: Each concept has a heading with a definition, and relationships are stated.
      fail: A core concept is missing or relationships are never explained.
  - use: fresh-enough
  # Error severity on purpose: this page carries a citation whose hash does
  # not match anything in the source (CHANGED) and one whose source is gone
  # (MISSING), so it fails, and CI asserts that it does (ADR 01045).
  - use: cited-sources-current
    severity: error
cites:
  - id: action-table
    src: test/fixtures/cited/greeting.sh:6-6
    sha256: b77077d2f77efc93dac02b913fe9283492790fdfab124ca1198f731a5e4cdb64
---

Learn the key concepts that form the foundation of Doc Detective.

## Test specification

A [test specification](/reference/schemas/specification) is a group of tests to run in one or more contexts. Conceptually parallel to a document.

## Test

A [test](/docs/get-started/how-testing-works) is a sequence of steps to perform. Conceptually parallel to a procedure.

## Step

<!-- cite: src=test/fixtures/cited/missing.sh:1-2 sha256=4795a4d56b39fa1373a5b3b9992dfc059e68490deb4717d70fd426bf4fb05421 -->
A step is a portion of a test that includes a single action. Conceptually parallel to a step in a procedure.

## Action

<!-- cite: action-table -->
An action performs a task in a step. Doc Detective supports a variety of actions:

| Name                                                        | Description                                                                                                                                               |
| :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [checkLink](/docs/actions/checklink)         | Check if a URL returns an acceptable status code from a GET request.                                                                                      |
| [find](/docs/actions/find)                   | Locate and interact with an element on the page.                                                                                                          |
| [click](/docs/actions/click)                 | Click an element.                                                                                                                                         |
| [goTo](/docs/actions/goto)                   | Navigate to a specified URL.                                                                                                                              |
| [httpRequest](/docs/actions/httprequest)     | Perform a generic HTTP request, for example to an API.                                                                                                    |
| [runShell](/docs/actions/runshell)           | Perform a native shell command.                                                                                                                           |
| [runBrowserScript](/docs/actions/runbrowserscript) | Run JavaScript in the browser page context and capture its return value.                                                                            |
| [screenshot](/docs/actions/screenshot)       | Take a screenshot in PNG format.                                                                                                                          |
| [closeSurface](/docs/actions/closesurface)   | Close a surface, such as a background process started by `runShell` or `runCode`.                                                                          |
| [loadVariables](/docs/actions/loadvariables) | Load environment variables from a `.env` file.                                                                                                            |
| [saveCookie](/docs/actions/savecookie)       | Save a specific browser cookie to a file or environment variable for later reuse.                                                                         |
| [loadCookie](/docs/actions/loadcookie)       | Load a specific cookie from a file or environment variable into the browser.                                                                              |
| [record](/docs/actions/record)               | Capture a video of the test run.                                                                                                                              |
| [stopRecord](/docs/actions/stoprecord)       | Stop capturing a video of the test run.                                                                                                                       |
| [type](/docs/actions/type)                   | Type keys. To type special keys, begin and end the string with `$` and use the special key’s enum. For example, to type the Escape key, enter `$ESCAPE$`. |
| [wait](/docs/actions/wait)                   | Pause before performing the next action.                                                                                                                  |

## Context

<!-- cite: src=test/fixtures/cited/greeting.sh:5 -->
A [context](/reference/schemas/context) consists of an application and platforms that support the tests.

## Next steps

<!-- cite: nowhere -->
- [Create your first test](/docs/get-started/create-your-first-test)
