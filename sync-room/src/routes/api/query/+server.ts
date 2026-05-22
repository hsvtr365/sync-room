import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pool } from '$lib/server/db';
import { broadcast } from '$lib/server/broadcast';

const ALLOWED_TABLES = ['rooms', 'participants', 'unavailable_slots'];

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { table, action, data, eqFilters, inFilters } = body;

    if (!ALLOWED_TABLES.includes(table)) {
      return json(
        { data: null, error: { message: `Unauthorized table name: ${table}` } },
        { status: 400 }
      );
    }

    const client = await pool.connect();
    try {
      const whereClauses: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // 1. Build WHERE clauses for filters
      if (eqFilters) {
        for (const [col, val] of Object.entries(eqFilters)) {
          whereClauses.push(`"${col}" = $${paramIndex++}`);
          params.push(val);
        }
      }
      if (inFilters) {
        for (const [col, vals] of Object.entries(inFilters)) {
          if (Array.isArray(vals)) {
            whereClauses.push(`"${col}" = ANY($${paramIndex++})`);
            params.push(vals);
          }
        }
      }

      const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // 2. Execute SQL based on action
      if (action === 'select') {
        const sql = `SELECT * FROM "${table}" ${whereStr} ORDER BY created_at ASC`;
        const res = await client.query(sql, params);
        return json({ data: res.rows, error: null });
      }

      if (action === 'insert') {
        const dataList = Array.isArray(data) ? data : [data];
        const insertedRows: any[] = [];

        for (const row of dataList) {
          const keys = Object.keys(row);
          const colNames = keys.map((k) => `"${k}"`).join(', ');
          
          const rowParams = Object.values(row);
          const placeholders = keys.map(() => `$${paramIndex++}`).join(', ');
          params.push(...rowParams);

          const sql = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) RETURNING *`;
          const res = await client.query(sql, params.splice(0, params.length));
          paramIndex = 1; // reset param index for potential next iteration
          insertedRows.push(res.rows[0]);
        }

        // Broadcast insertions
        for (const row of insertedRows) {
          broadcast(table, 'INSERT', row);
        }

        const responseData = Array.isArray(data) ? insertedRows : insertedRows[0];
        return json({ data: responseData, error: null });
      }

      if (action === 'update') {
        const keys = Object.keys(data);
        if (keys.length === 0) {
          return json(
            { data: [], error: { message: 'No data to update' } },
            { status: 400 }
          );
        }

        const setClauses: string[] = [];
        const updateParams: any[] = [];
        let updateParamIndex = 1;

        for (const k of keys) {
          setClauses.push(`"${k}" = $${updateParamIndex++}`);
          updateParams.push(data[k]);
        }

        // Append filters to parameters
        const finalParams = [...updateParams];
        const updateWhereClauses: string[] = [];

        if (eqFilters) {
          for (const [col, val] of Object.entries(eqFilters)) {
            updateWhereClauses.push(`"${col}" = $${updateParamIndex++}`);
            finalParams.push(val);
          }
        }
        if (inFilters) {
          for (const [col, vals] of Object.entries(inFilters)) {
            if (Array.isArray(vals)) {
              updateWhereClauses.push(`"${col}" = ANY($${updateParamIndex++})`);
              finalParams.push(vals);
            }
          }
        }

        const updateWhereStr = updateWhereClauses.length > 0 ? `WHERE ${updateWhereClauses.join(' AND ')}` : '';
        const sql = `UPDATE "${table}" SET ${setClauses.join(', ')} ${updateWhereStr} RETURNING *`;
        
        const res = await client.query(sql, finalParams);

        // Broadcast updates
        for (const row of res.rows) {
          broadcast(table, 'UPDATE', row);
        }

        return json({ data: res.rows, error: null });
      }

      if (action === 'delete') {
        const sql = `DELETE FROM "${table}" ${whereStr} RETURNING *`;
        const res = await client.query(sql, params);

        // Broadcast deletions
        for (const row of res.rows) {
          broadcast(table, 'DELETE', row);
        }

        return json({ data: res.rows, error: null });
      }

      return json(
        { data: null, error: { message: `Unsupported action: ${action}` } },
        { status: 400 }
      );
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('API query error:', error);
    return json(
      { data: null, error: { message: error.message || 'Server error' } },
      { status: 500 }
    );
  }
};
