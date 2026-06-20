if (action === "login") {
  if (!req.body) {
    return res.status(400).json({
      success: false,
      error: "Request body missing (use POST)"
    })
  }

  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password required"
    })
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  })

  if (error) throw error

  return res.json({ success: true, data })
}
