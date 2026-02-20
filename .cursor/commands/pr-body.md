Write a narrative PR body for the changes in the current branch.

Focus on the overall picture.
Do not just blindly list every change.
Only include specific changes if its relevant to understand the PR changes.

Use the PR template in `.github/pull_request_template.md` as the schema:
- **IMPORTANT:** Remove all comments from the template.
- Add content to the relevant sections.
- Remove "Additional Notes" section if it doesn't add any value.
- Use commit messages in the branch as a staring point.
- Use markdown.
- Use backticks for all file/path and inline code references.
- Don't break lines unnecessarily.
- Add an empty line after each markdown headline, before the text.

**IMPORTANT:** Output the final PR body in a code block formatted using 4 backticks, so it's easy to copy/paste even if the content itself contains 3 backticks in a row.
