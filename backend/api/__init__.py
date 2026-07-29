"""FastAPI route handlers.

Deliberately empty of imports. Re-exporting :data:`api.router.api_router` from
here pulled every route module into any import that merely touched an ``api.*``
name — including the ones the lower layers make — which turned the package into
the hub of an import cycle. Import :mod:`api.router` directly instead.
"""
