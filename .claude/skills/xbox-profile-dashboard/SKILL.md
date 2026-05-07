```markdown
# xbox-profile-dashboard Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you how to contribute to and maintain the `xbox-profile-dashboard` Python project. You'll learn the project's coding conventions, commit message patterns, and how to work with its testing structure. The repository is a Python codebase (no framework detected) that uses conventional commits and emphasizes clean, modular code organization.

## Coding Conventions

### File Naming
- Use **snake_case** for all filenames.
  - Example: `user_profile.py`, `dashboard_utils.py`

### Import Style
- Use **relative imports** within the project.
  - Example:
    ```python
    from .utils import fetch_gamertag
    ```

### Export Style
- Use **named exports** (explicitly define what is exported from a module).
  - Example:
    ```python
    def get_profile_data(user_id):
        ...
    ```

### Commit Messages
- Follow the **Conventional Commits** standard.
- Use the `feat` prefix for new features.
- Keep commit messages concise (average 72 characters).
  - Example:
    ```
    feat: add recent games section to dashboard
    ```

## Workflows

### Adding a New Feature
**Trigger:** When you want to introduce a new capability or section to the dashboard.
**Command:** `/add-feature`

1. Create a new Python file using snake_case if needed.
2. Write your feature code, using relative imports for internal modules.
3. Export functions or classes by name.
4. Write or update tests in a corresponding `*.test.*` file.
5. Commit your changes using the `feat` prefix and a concise message.
    - Example: `feat: implement avatar upload functionality`
6. Push your branch and open a pull request.

### Running Tests
**Trigger:** Before merging or after making changes to ensure code correctness.
**Command:** `/run-tests`

1. Locate test files matching the `*.test.*` pattern.
2. Run tests using your preferred Python test runner (e.g., `pytest`, `unittest`).
    - Example: 
      ```bash
      python -m unittest discover -s . -p "*.test.*"
      ```
3. Review test results and fix any failures.

## Testing Patterns

- Test files follow the `*.test.*` naming pattern (e.g., `profile.test.py`).
- The specific testing framework is not enforced—use any Python test runner.
- Place tests alongside or near the code they cover.
- Example test structure:
  ```python
  # profile.test.py
  from .profile import get_profile_data

  def test_get_profile_data_returns_dict():
      result = get_profile_data('user123')
      assert isinstance(result, dict)
  ```

## Commands
| Command      | Purpose                                      |
|--------------|----------------------------------------------|
| /add-feature | Start the workflow for adding a new feature  |
| /run-tests   | Run all test files matching *.test.* pattern |
```
