import { supabase } from '../lib/supabase.js'
import { uploadToGoogleDrive, getOrCreateFolder } from '../lib/gdrive.js'
import { sendPushNotification } from '../lib/firebase.js'

export default async function handler(req, res) {

  // ===============================
  // 🌐 CORS
  // ===============================
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' })

  const startTime = Date.now()

  try {
    const { action, email, password, token, ...payload } = req.body

    if (!action) throw new Error("Action is required")

    // ===============================
    // 🔐 AUTH CHECK
    // ===============================
    let userContext = null
    const publicActions = ["login", "submitInstituteRegistration"]

    if (!publicActions.includes(action)) {
      const { data: { user }, error } = await supabase.auth.getUser(token)
      if (error || !user) {
        return res.status(200).json({ authFailed: true, message: "Session expired" })
      }
      userContext = user
    }

    // ===============================
    // ⚡ HANDLERS (ULTRA FAST ROUTER)
    // ===============================
    const handlers = {

      // ===============================
      // 🔐 LOGIN
      // ===============================
      login: async () => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error

        const { data: profile } = await supabase
          .from('users')
          .select('id, email, role, status')
          .eq('auth_user_id', data.user.id)
          .single()

        if (!profile || profile.status !== 'Active') {
          throw new Error("Account inactive")
        }

        return {
          success: true,
          email: profile.email,
          role: profile.role,
          token: data.session.access_token
        }
      },

      // ===============================
      // 📊 DASHBOARD (PARALLEL FETCH)
      // ===============================
      getDashboardPayload: async () => {

        const { data: userData } = await supabase
          .from('users')
          .select('*, institutes(*), operator_profiles(*)')
          .eq('auth_user_id', userContext.id)
          .single()

        const dashRole = userData.role
        const userId = userData.id
        const instId = userData.institute_id

        let papersQuery = supabase.from('jobs_queue').select('*').eq('job_type', 'Paper')
        let docsQuery = supabase.from('jobs_queue').select('*').neq('job_type', 'Paper')

        if (dashRole === 'teacher') {
          papersQuery = papersQuery.eq('requester_id', userId)
          docsQuery = docsQuery.eq('requester_id', userId)
        }
        if (dashRole === 'admin') {
          papersQuery = papersQuery.eq('institute_id', instId)
          docsQuery = docsQuery.eq('institute_id', instId)
        }
        if (dashRole === 'operator') {
          papersQuery = papersQuery.eq('operator_id', userId)
          docsQuery = docsQuery.eq('operator_id', userId)
        }

        // 🔥 PARALLEL EXECUTION
        const [papers, docs, notifications] = await Promise.all([
          papersQuery.order('created_at', { ascending: false }),
          docsQuery.order('created_at', { ascending: false }),
          supabase.from('notifications')
            .select('*')
            .contains('target_roles', [userData.role])
            .limit(30)
        ])

        return {
          success: true,
          profile: userData,
          jobs: [...(papers.data || []), ...(docs.data || [])],
          notifications: notifications.data || []
        }
      },

      // ===============================
      // 📄 CREATE JOB (OPTIMIZED)
      // ===============================
      submitPaperJob: async () => {

        const { data: dbUser } = await supabase
          .from('users')
          .select('id, institute_id')
          .eq('auth_user_id', userContext.id)
          .single()

        const { data: dbInst } = await supabase
          .from('institutes')
          .select('id, institute_code, institute_name')
          .eq('id', dbUser.institute_id)
          .single()

        const instCode = dbInst.institute_code
        const instName = dbInst.institute_name

        // 🔥 FAST JOB ID
        const jobId = `${instCode}-${Date.now()}`

        let fileUrl = ""
        if (payload.fileBase64) {
          const folder = await getOrCreateFolder(instName)
          fileUrl = await uploadToGoogleDrive(
            payload.fileBase64,
            jobId + ".pdf",
            payload.mimeType,
            folder
          )
        }

        // 🔥 INSERT FAST
        await supabase.from('jobs_queue').insert([{
          job_code: jobId,
          institute_id: dbUser.institute_id,
          requester_id: dbUser.id,
          status: "Pending",
          raw_file_url: fileUrl,
          meta_data: payload
        }])

        return { success: true, jobId }
      },

      // ===============================
      // 🔔 NOTIFICATION
      // ===============================
      sendNotification: async () => {
        await supabase.from('notifications').insert([{
          sender_id: userContext.id,
          title: payload.title,
          message: payload.msg,
          target_roles: [payload.targetRaw]
        }])
        return { success: true }
      }

    }

    // ===============================
    // 🚀 EXECUTE ACTION
    // ===============================
    if (!handlers[action]) {
      throw new Error("Invalid action: " + action)
    }

    const result = await handlers[action]()

    // ===============================
    // ⚡ PERFORMANCE LOG
    // ===============================
    console.log(`⚡ ${action} executed in ${Date.now() - startTime}ms`)

    return res.status(200).json(result)

  } catch (err) {
    console.error("🔥 ERROR:", err.message)
    return res.status(200).json({
      success: false,
      message: err.message
    })
  }
}
