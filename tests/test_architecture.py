from __future__ import annotations

import ast
from pathlib import Path

PACKAGE_ROOT = Path(__file__).parents[1] / "src" / "roleloop"


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def assert_layer_has_no_imports(layer: str, forbidden_prefixes: tuple[str, ...]) -> None:
    failures: list[str] = []
    for path in sorted((PACKAGE_ROOT / layer).rglob("*.py")):
        for module in sorted(imported_modules(path)):
            if module.startswith(forbidden_prefixes):
                failures.append(f"{path.relative_to(PACKAGE_ROOT)} imports {module}")
    assert not failures, "Layer boundary violations:\n" + "\n".join(failures)


def test_domain_is_framework_free() -> None:
    assert_layer_has_no_imports(
        "domain",
        (
            "roleloop.application",
            "roleloop.infrastructure",
            "roleloop.adapters",
            "sqlite3",
            "textual",
            "pypdf",
            "platformdirs",
        ),
    )


def test_application_does_not_depend_on_adapters_or_infrastructure() -> None:
    assert_layer_has_no_imports(
        "application",
        (
            "roleloop.infrastructure",
            "roleloop.adapters",
            "sqlite3",
            "textual",
            "pypdf",
            "platformdirs",
        ),
    )
