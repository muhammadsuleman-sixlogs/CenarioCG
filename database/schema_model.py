from dataclasses import dataclass, field
from typing import List


@dataclass
class Column:
    name: str
    data_type: str


@dataclass
class PrimaryKey:
    table_name: str
    column_name: str


@dataclass
class ForeignKey:
    source_table: str
    source_column: str
    target_table: str
    target_column: str


@dataclass
class Table:
    name: str
    columns: List[Column] = field(default_factory=list)
    primary_keys: List[str] = field(default_factory=list)
    foreign_keys: List[ForeignKey] = field(default_factory=list)


@dataclass
class DatabaseSchema:
    tables: List[Table] = field(default_factory=list)