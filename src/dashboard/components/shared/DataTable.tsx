/**
 * Generic typed table, ported from brain's dashboard shared components and
 * adapted to active-work's own tokens. Extended with an optional `renderRow`
 * so callers needing native drag-and-drop (unsupported by RNW's `View`,
 * which only forwards an allowlisted prop set) can wrap each row in a plain
 * DOM element instead of the default `View`.
 */
import React from 'react';
import { View, Text } from 'react-native';
import { palette } from '../../tokens.js';

export interface DataTableColumn {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'right';
  flex?: number;
}

export interface DataTableProps<T> {
  columns: DataTableColumn[];
  data: T[];
  renderCell: (item: T, columnKey: string) => React.ReactNode;
  highlightRow?: (item: T) => boolean;
  getKey: (item: T) => string;
  emptyText?: string;
  /** Override the default row wrapper, e.g. to attach drag handlers. */
  renderRow?: (item: T, cells: React.ReactNode) => React.ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  renderCell,
  highlightRow,
  getKey,
  emptyText = 'No data',
  renderRow,
}: DataTableProps<T>): React.JSX.Element {
  if (data.length === 0) {
    return <Text style={{ fontSize: 14, color: palette.textTertiary }}>{emptyText}</Text>;
  }

  return (
    <View>
      {data.map((item) => {
        const highlighted = highlightRow?.(item) ?? false;
        const cells = columns.map((col) => (
          <View
            key={col.key}
            style={{
              justifyContent: 'center',
              alignItems: col.align === 'right' ? 'flex-end' : undefined,
              ...(col.width != null ? { width: col.width } : { flex: col.flex ?? 1 }),
            }}
          >
            {renderCell(item, col.key)}
          </View>
        ));

        if (renderRow) {
          return <React.Fragment key={getKey(item)}>{renderRow(item, cells)}</React.Fragment>;
        }

        return (
          <View
            key={getKey(item)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: palette.border,
              ...(highlighted
                ? { backgroundColor: 'rgba(255,121,0,0.06)', borderRadius: 6, paddingHorizontal: 6 }
                : {}),
            }}
          >
            {cells}
          </View>
        );
      })}
    </View>
  );
}
