"""Pydantic models for API request/response contracts, grouped by domain.

A leaf package: it depends on nothing but ``pydantic`` and the stdlib, so every
layer — ``api``, ``store``, ``llm``, ``mcp_integration`` — can import the
contracts without importing each other. These models used to live under ``api``,
which forced the lower layers to reach up into the route package and made the
import graph cyclic.

Keep this ``__init__`` import-free: re-exporting the submodules here would
recreate the hub problem one level down.
"""
