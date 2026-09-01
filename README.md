<p align="center">
  <a href="https://burla.dev">
    <img src="https://backend.burla.dev/static/logo.svg" width="264" alt="Burla">
  </a>
</p>

<p align="center">
  <b>The simplest way to scale Python.</b>
</p>

<p align="center">
  <a href="https://burla.dev/docs">Documentation</a> ·
  <a href="https://burla.dev/docs/get-started">Getting started</a> ·
  <a href="https://burla.dev/docs/api-reference">API reference</a> ·
  <a href="https://burla.dev/docs/examples">Examples</a> ·
  <a href="https://burla.dev">Website</a>
</p>

<p align="center">
  <a href="https://pypi.org/project/burla/"><img src="https://img.shields.io/pypi/v/burla" alt="PyPI"></a>
  <a href="https://pepy.tech/projects/burla"><img src="https://img.shields.io/pepy/dt/burla?color=brightgreen" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-blue" alt="Python 3.11+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-lightgrey" alt="License"></a>
</p>

---

Burla is a distributed computing framework that runs plain Python functions across thousands of CPUs or GPUs in your own cloud. It has exactly one function:

```python
from burla import remote_parallel_map

my_inputs = list(range(1000))

def my_function(x):
    print(f"[#{x}] running on separate computer")

remote_parallel_map(my_function, my_inputs)
```

This example asks Burla to scale the job to 1,000 CPUs and run 1,000 function calls in parallel:

<p align="center">
  <img src="https://raw.githubusercontent.com/Burla-Cloud/user-docs/main/.gitbook/assets/hell_cut_extended_no-zsh.gif" alt="Burla terminal demo showing remote_parallel_map running 1,000 function calls" width="90%">
</p>

## Highlights

- **One function.** `results = remote_parallel_map(my_function, my_inputs)` is the entire API. No DAGs, no YAML, no cluster SDK to learn.
- **Feels local.** Anything your function prints streams back to your terminal. Exceptions are re-raised locally with full tracebacks. Packages missing from the image are installed automatically, and import-time local modules ship with your function.
- **Fast dispatch.** On a warm cluster, a print-only job across 1,000 CPUs completes in under a second.
- **Runs in your cloud.** Burla runs your functions on raw VMs in your own cloud account, not shared Burla infrastructure.
- **Hardware and images in code.** Request CPUs or RAM per function call, add A100 or H100 GPUs on AWS or Google Cloud, and select a compatible `linux/amd64` image.
- **Adaptive concurrency.** On CPU nodes, the default dynamic CPU and RAM settings start one worker per CPU, then reduce node concurrency under pressure when possible.
- **Built-in dashboard.** View live logs and node status locally; deploy it for background jobs and access from any device.


## Contributing

Bug reports and feature requests are welcome in [GitHub issues](https://github.com/Burla-Cloud/burla/issues). If you'd like to contribute code, open an issue first so we can point you in the right direction. To report a security issue, email security@burla.dev.

## License

Burla is licensed under the [Functional Source License, Version 1.1, with Apache 2.0 Future License](LICENSE) (FSL-1.1-Apache-2.0). You can use, copy, modify, and redistribute it for any purpose except a competing commercial offering, and each version becomes available under Apache 2.0 two years after its release.

---

<p align="center">
  Questions? Email <a href="mailto:jake@burla.dev">jake@burla.dev</a> or <a href="https://cal.com/jakez/burla?user=jakez">book a call</a>, we're always happy to talk.
</p>
