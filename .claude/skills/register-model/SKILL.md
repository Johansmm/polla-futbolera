---
name: register-model
description: Register a model (or model variants) into the MLflow server by reading the model's README.md. Use when the user wants to register a model defined under models/.
---

# Register Model

This skill registers one or more Gen3 model variants into the MLflow server by extracting
and executing the registration code from the model's `README.md`.

## Trigger

Use this skill when the user wants to register a model that lives under `models/` in this
repository. The user may say things like "register the whisper model", "register mnist",
or simply invoke `/register-model`.

## Steps

### 1. Identify the model directory

If the user specified a model name, map it to `models/<name>/`. If ambiguous or not
specified, list the directories under `models/` and ask the user to pick one.

### 2. Read the README.md

Read `models/<name>/README.md`. Locate the **Register** section — it contains a Python
code block with the `register_model(...)` call(s) to execute.

If no `README.md` exists, or if the README exists but has no **Register** section, ask
the user:

> There are no registration instructions for this model yet. Would you like me to help
> you create them?

If the user says yes, ask them to describe how the model should be registered (artifacts
needed, variants, metadata) and write a `README.md` (or add a **Register** section to
the existing one) following the same format as other models in the repository. Then
continue with step 3 using the newly written instructions.

### 3. Identify placeholder paths

Scan the code block for string literals that look like placeholder paths
(e.g. `"/path/to/..."`, `"<...>"`). For each one, ask the user for the real absolute
path before proceeding. Substitute the placeholders with the paths provided.

### 4. Check MLFLOW_TRACKING_URI

Run `echo $MLFLOW_TRACKING_URI` to check the current value.

- If set to a valid `http://` or `https://` address, use it as-is.
- If empty, inform the user:

> `MLFLOW_TRACKING_URI` is not set — the model will be registered locally in `./mlruns`.
> To register on the remote server instead, provide an address (e.g. `http://172.17.0.41:5000`)
> or leave blank to continue with local registration.

Use the value they confirm (or leave unset for local), passing it inline to the command
in step 6 as `MLFLOW_TRACKING_URI=<value>`. Do not require the user to export it themselves.

### 5. Resolve the virtual environment to use

Ask the user:

> Which virtual environment should be used for registration?
> Leave blank to use the currently active Python (`which python`).

If the user provides a path, resolve the Python interpreter as `<path>/bin/python`.
If blank, run `which python` to confirm the active interpreter and show it to the user
before continuing.

### 6. Run the registration code

Run the extracted (and path-substituted) code block directly with `-c` from the
**current working directory**, so that `models/` and `gen3_model_zoo/` are importable:

```bash
cd <repo-root> && MLFLOW_TRACKING_URI=<value> <venv>/bin/python -c "<code block>"
```

Capture stdout/stderr.

- On success, parse each `result.registered_model_version` from stdout and update the
  corresponding entry in `models/<name>/<name>.json`, writing `"version"` for each
  registered model. Save the file when all variants are done.
- On failure with an `ImportError` / `ModuleNotFoundError`, ask the user for the
  absolute path to the `gen3-model-zoo` repo root, then retry with `cd <that path>`.
- On other failures, help the user diagnose the error (missing credential file,
  unreachable server, wrong artifact path, etc.).

### 7. Verify credentials if the run fails with 401/403

If the script fails with an authentication error, remind the user to set up
`~/.mlflow/credentials`:

```ini
[mlflow]
mlflow_tracking_username = your.email@brainchip.com
mlflow_tracking_password = <your-token>
```

### 8. Report result

For each model registered, print:
- The MLflow model name
- The registered version number (if available from the output)
- The model ID

Remind the user that the new version starts at stage `None` and CI will pick it up
automatically for load-testing and promotion.

## Important rules

- **Never commit the registration script** — it is a one-time local operation.
- **Never commit `~/.mlflow/credentials`** — it contains secrets.
- If the README code block registers multiple variants in a loop, run them all in the
  same script execution. Do not split variants across separate runs.
