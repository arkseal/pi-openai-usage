# Development and compatibility

Development checks pin Pi **1.5.0** and TypeBox **1.3.27**, matching the audited
host. Wildcard peers follow Pi's host-module contract; dev dependencies make the
tested versions explicit instead of relying on automatic peer installation.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check  # strict source and test checks
npm test
```

`bun.lock` is the canonical development lockfile. Tests use fixtures and mocked
transports and do not require account credentials. Numeric usage still depends
on OpenAI's private endpoint and a compatible existing OAuth grant; passing
unit tests cannot establish that every account is authorized to use that API.
