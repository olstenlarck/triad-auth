# Review decisions

- Thread matching uses only the root comment ID because users and agents only reply directly to findings (root comments), not to replies. The `in_reply_to_id` will always be the root comment's databaseId in this workflow. [Thread](https://github.com/tunnckoCoreHQ/monarch/pull/143#discussion_r1234567890)