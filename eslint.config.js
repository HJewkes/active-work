import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/dashboard/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'gray-matter',
              message:
                'Use parseFrontmatter/stringifyFrontmatter from src/utils/gray-matter-io.ts; bare gray-matter executes ---js frontmatter (TP-1007).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/utils/gray-matter-io.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
