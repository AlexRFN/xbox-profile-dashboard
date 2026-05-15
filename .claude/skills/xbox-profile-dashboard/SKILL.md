```markdown
# xbox-profile-dashboard Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the development patterns and conventions used in the `xbox-profile-dashboard` Python codebase. You'll learn how to structure files, write imports and exports, follow commit message conventions, and organize tests. This guide also provides step-by-step workflows and helpful commands to streamline your development process.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.py`, `dashboardView.py`

### Import Style
- Use **relative imports** within the project.
  - Example:
    ```python
    from .userProfile import UserProfile
    from .utils import fetchData
    ```

### Export Style
- Use **named exports** (explicitly specify what is exported).
  - Example:
    ```python
    __all__ = ['UserProfile', 'fetchData']
    ```

### Commit Messages
- Follow the **conventional commit** format.
- Use the `feat` prefix for new features.
- Commit messages are descriptive, averaging 106 characters.
  - Example:
    ```
    feat: add user avatar rendering to dashboard with fallback for missing images
    ```

## Workflows

### Feature Development
**Trigger:** When adding a new feature to the dashboard  
**Command:** `/feature-development`

1. Create a new file using camelCase (e.g., `newFeature.py`).
2. Implement the feature using relative imports as needed.
3. Add named exports to the file.
4. Write or update corresponding test files (`*.test.*`).
5. Commit your changes using the `feat` prefix and a descriptive message.
    - Example: `feat: implement recent activity feed for user profiles`
6. Push your changes and open a pull request.

### Testing
**Trigger:** When verifying code functionality  
**Command:** `/run-tests`

1. Identify or create test files matching the pattern `*.test.*`.
2. Run the tests using your preferred Python test runner (e.g., `pytest`, `unittest`).
3. Ensure all tests pass before merging changes.

## Testing Patterns

- Test files follow the pattern `*.test.*` (e.g., `userProfile.test.py`).
- The specific testing framework is not enforced; use your preferred Python testing tool.
- Place test files alongside the code they test or in a dedicated tests directory.
- Example test file:
    ```python
    # userProfile.test.py
    from .userProfile import UserProfile

    def test_user_profile_display_name():
        profile = UserProfile(gamertag="PlayerOne")
        assert profile.display_name() == "PlayerOne"
    ```

## Commands
| Command              | Purpose                                         |
|----------------------|-------------------------------------------------|
| /feature-development | Guide for adding a new feature                  |
| /run-tests           | Steps to run and verify tests                   |
```
