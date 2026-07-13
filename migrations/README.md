# Database migrations

Generate the schema from the pinned Better Auth RC after installing dependencies:

```sh
vp run auth:schema
```

The generated SQL belongs in this directory and is applied with `vp run db:local` or `vp run db:remote`.
