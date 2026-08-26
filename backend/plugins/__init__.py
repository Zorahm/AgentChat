"""Agent Plugins support — loading, validating and running plugin packages.

Deliberately import-free: an eager re-export here would turn the package into
a cycle hub (``tests/backend/test_import_graph.py`` pins the rule). Import the
modules directly, e.g. ``from plugins.registry import PluginRegistry``.
"""
